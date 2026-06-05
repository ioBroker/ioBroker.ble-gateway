"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const node_fs_1 = require("node:fs");
const scanner_1 = require("./lib/scanner");
const hci_info_1 = require("./lib/hci-info");
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const ALIVE_PREFIX = 'system.adapter.';
const ALIVE_SUFFIX = '.alive';
function readSysFile(path) {
    try {
        return (0, node_fs_1.readFileSync)(path, 'utf8').trim();
    }
    catch {
        return '';
    }
}
async function readHciAdapters() {
    // Primary: HCI ioctl (works regardless of sysfs attribute availability).
    try {
        const infos = await (0, hci_info_1.readHciInfos)();
        if (infos.length) {
            return infos.map(i => ({ id: i.devId, address: i.address.toUpperCase() })).sort((a, b) => a.id - b.id);
        }
    }
    catch {
        // fall through
    }
    // Fallback: sysfs. Older kernels and non-Linux platforms.
    const out = [];
    const sysPath = '/sys/class/bluetooth';
    try {
        if ((0, node_fs_1.existsSync)(sysPath)) {
            for (const name of (0, node_fs_1.readdirSync)(sysPath)) {
                const m = /^hci(\d+)$/.exec(name);
                if (!m) {
                    continue;
                }
                out.push({
                    id: parseInt(m[1], 10),
                    address: readSysFile(`${sysPath}/${name}/address`).toUpperCase(),
                });
            }
        }
    }
    catch {
        // ignore
    }
    out.sort((a, b) => a.id - b.id);
    return out;
}
// Resolve a configured value (MAC string or numeric index) to the current hciX id.
// Returns -1 if a MAC was given but no controller currently exposes it.
async function resolveHciId(value) {
    if (typeof value === 'string' && MAC_RE.test(value.trim())) {
        const wanted = value.trim().toUpperCase();
        const adapters = await readHciAdapters();
        const match = adapters.find(a => a.address === wanted);
        return match ? match.id : -1;
    }
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}
async function listHciAdapters() {
    // Primary: query each controller via raw HCI commands (Read_BD_ADDR /
    // Read_Local_Name). Recent Pi kernels no longer expose those attributes in
    // sysfs, so this is the only reliable source for both name and MAC.
    const out = [];
    try {
        const infos = await (0, hci_info_1.readHciInfos)();
        for (const info of infos) {
            const parts = [];
            if (info.name) {
                parts.push(info.name);
            }
            if (info.address) {
                parts.push(info.address);
            }
            const hciName = `hci${info.devId}`;
            const label = parts.length ? `${hciName} — ${parts.join(' · ')}` : hciName;
            out.push({ value: info.address || info.devId, label });
        }
    }
    catch {
        // fall through to sysfs probe
    }
    if (out.length) {
        return out;
    }
    // Fallback: sysfs (older kernels, non-Linux dev environments).
    const sysPath = '/sys/class/bluetooth';
    try {
        if ((0, node_fs_1.existsSync)(sysPath)) {
            for (const name of (0, node_fs_1.readdirSync)(sysPath)) {
                const m = /^hci(\d+)$/.exec(name);
                if (!m) {
                    continue;
                }
                const id = parseInt(m[1], 10);
                const base = `${sysPath}/${name}`;
                const address = readSysFile(`${base}/address`).toUpperCase();
                const product = readSysFile(`${base}/device/product`);
                const manufacturer = readSysFile(`${base}/device/manufacturer`);
                const friendly = product || manufacturer;
                const parts = [];
                if (friendly) {
                    parts.push(friendly);
                }
                if (address) {
                    parts.push(address);
                }
                const label = parts.length ? `${name} — ${parts.join(' · ')}` : name;
                out.push({ value: address || id, label });
            }
        }
    }
    catch {
        // ignore
    }
    return out;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Reduce a Bluetooth UUID to a comparable canonical form: lowercase hex without
// separators, with the 128-bit base UUID collapsed to its 16-bit short form.
function normalizeUuid(u) {
    const s = (u || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (s.length === 32 && s.startsWith('0000') && s.endsWith('00001000800000805f9b34fb')) {
        return s.slice(4, 8);
    }
    return s;
}
function parsePrefixes(raw) {
    if (!raw) {
        return [];
    }
    return raw
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(p => p.length > 0);
}
function matchesPrefix(name, prefixes) {
    if (!prefixes.length) {
        return true;
    }
    if (!name) {
        return false;
    }
    const lower = name.toLowerCase();
    return prefixes.some(p => lower.startsWith(p));
}
function isEmptyFilter(f) {
    return (!(f.macs && f.macs.length) &&
        !(f.serviceUuids && f.serviceUuids.length) &&
        !(f.namePrefixes && f.namePrefixes.length) &&
        f.manufacturerId === undefined);
}
class BleGatewayAdapter extends adapter_core_1.Adapter {
    noble = null;
    scanner = null;
    currentHci = -1;
    stopping = false;
    // key = `${subscriberId}::${subscriptionId}`
    subscriptions = new Map();
    // subscriberIds whose `.alive` foreign state we currently watch
    watchedAlive = new Set();
    // Active diagnostic-scan collector (admin "scan" button); null when idle.
    diag = null;
    constructor(options = {}) {
        super({
            ...options,
            name: 'ble-gateway',
            unload: cb => this.onUnload(cb),
            message: obj => this.onAdapterMessage(obj),
            stateChange: (id, state) => this.onStateChange(id, state),
            ready: () => this.onReady(),
        });
    }
    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.subscribers', 0, true);
        await this.setStateAsync('info.subscriptions', '[]', true);
        if (process.platform !== 'linux' && process.platform !== 'darwin') {
            this.log.warn(`BLE scanning requires Linux (BlueZ) or macOS. Current platform: ${process.platform}. ` +
                `The gateway stays up but cannot open a controller here.`);
        }
        // Intentionally do NOT open the controller here. noble is initialised
        // lazily on the first subscribe, so with no subscribers no port is opened.
        this.log.info('ble-gateway ready — waiting for subscribers (no BLE port opened until first subscribe).');
    }
    onUnload(cb) {
        this.stopping = true;
        const finish = () => {
            try {
                cb();
            }
            catch {
                // ignore
            }
        };
        if (this.scanner) {
            void this.scanner.stop().finally(finish);
        }
        else {
            finish();
        }
    }
    onStateChange(id, state) {
        if (!id.startsWith(ALIVE_PREFIX) || !id.endsWith(ALIVE_SUFFIX)) {
            return;
        }
        const subscriberId = id.slice(ALIVE_PREFIX.length, id.length - ALIVE_SUFFIX.length);
        // alive removed (null) or turned false → the subscriber is gone.
        if (!state || state.val === false) {
            if (this.hasSubscriber(subscriberId)) {
                this.log.info(`Subscriber ${subscriberId} is no longer alive — dropping its subscriptions`);
                void this.removeSubscriptionsFor(subscriberId);
            }
        }
    }
    // ---- noble / scanner lifecycle ---------------------------------------
    async ensureNoble(hciId) {
        if (this.noble && this.currentHci === hciId) {
            return;
        }
        if (this.noble) {
            // The @stoprocent/noble HCI binding holds native socket state that
            // cannot be cleanly reset in-process. Switching controllers requires
            // a process restart.
            throw new Error(`Cannot switch to hci${hciId} in-process — please restart the adapter to apply the change.`);
        }
        process.env.NOBLE_HCI_DEVICE_ID = String(hciId);
        const nobleModule = require('@stoprocent/noble');
        try {
            this.noble = nobleModule.withBindings('hci', { deviceId: hciId });
        }
        catch {
            this.noble = nobleModule.withBindings ? nobleModule.withBindings('hci') : nobleModule;
        }
        this.currentHci = hciId;
        this.scanner = new scanner_1.BleScanner(this.noble, {
            info: m => this.log.info(m),
            warn: m => this.log.warn(m),
            error: m => this.log.error(m),
            debug: m => this.log.debug(m),
        });
        await this.scanner.waitPoweredOn(15000);
        this.log.info(`Bluetooth controller hci${hciId} powered on`);
    }
    // Start scanning if not already running. Caller must have called ensureNoble.
    async ensureScanning() {
        if (!this.scanner) {
            throw new Error('BLE not initialised');
        }
        if (this.scanner.isScanning()) {
            return;
        }
        await this.scanner.start(adv => this.handleAdvertisement(adv));
    }
    // Stop scanning when nothing needs the controller any more.
    async maybeStopScanning() {
        if (this.subscriptions.size === 0 && !this.diag && this.scanner?.isScanning()) {
            await this.scanner.stop();
            await this.setStateAsync('info.connection', false, true);
        }
    }
    // ---- subscriptions ----------------------------------------------------
    hasSubscriber(subscriberId) {
        for (const sub of this.subscriptions.values()) {
            if (sub.subscriberId === subscriberId) {
                return true;
            }
        }
        return false;
    }
    async watchAlive(subscriberId) {
        if (this.watchedAlive.has(subscriberId)) {
            return;
        }
        this.watchedAlive.add(subscriberId);
        try {
            await this.subscribeForeignStatesAsync(`${ALIVE_PREFIX}${subscriberId}${ALIVE_SUFFIX}`);
        }
        catch (e) {
            this.log.debug(`watchAlive ${subscriberId}: ${e.message}`);
        }
    }
    async unwatchAlive(subscriberId) {
        if (!this.watchedAlive.has(subscriberId)) {
            return;
        }
        this.watchedAlive.delete(subscriberId);
        try {
            await this.unsubscribeForeignStatesAsync(`${ALIVE_PREFIX}${subscriberId}${ALIVE_SUFFIX}`);
        }
        catch {
            // ignore
        }
    }
    async removeSubscriptionsFor(subscriberId) {
        let removed = 0;
        for (const [key, sub] of this.subscriptions) {
            if (sub.subscriberId === subscriberId) {
                this.subscriptions.delete(key);
                removed++;
            }
        }
        if (removed) {
            await this.unwatchAlive(subscriberId);
            await this.updateInfoStates();
            await this.maybeStopScanning();
        }
    }
    async updateInfoStates() {
        const subscribers = new Set();
        const list = [];
        for (const sub of this.subscriptions.values()) {
            subscribers.add(sub.subscriberId);
            list.push({ subscriber: sub.subscriberId, subscriptionId: sub.subscriptionId, filter: sub.filter });
        }
        await this.setStateAsync('info.subscribers', subscribers.size, true);
        await this.setStateAsync('info.subscriptions', JSON.stringify(list), true);
    }
    controllerInfo() {
        return {
            hciId: this.currentHci,
            powerState: this.scanner?.getPowerState() ?? 'unknown',
            scanning: this.scanner?.isScanning() ?? false,
        };
    }
    // ---- advertisement matching & delivery --------------------------------
    handleAdvertisement(adv) {
        if (this.diag) {
            const prev = this.diag.get(adv.address);
            if (!prev || (adv.localName && !prev.localName)) {
                this.diag.set(adv.address, {
                    address: adv.address,
                    localName: adv.localName || '',
                    rssi: adv.rssi,
                });
            }
        }
        if (!this.subscriptions.size) {
            return;
        }
        const now = Date.now();
        for (const sub of this.subscriptions.values()) {
            if (!this.matchFilter(sub.filter, adv)) {
                continue;
            }
            if (sub.minIntervalMs > 0) {
                const last = sub.lastSent.get(adv.address) || 0;
                if (now - last < sub.minIntervalMs) {
                    continue;
                }
                sub.lastSent.set(adv.address, now);
            }
            this.deliver(sub, adv, now);
        }
    }
    matchFilter(f, adv) {
        if (f.macs && f.macs.length) {
            if (!f.macs.includes(adv.address)) {
                return false;
            }
        }
        if (f.serviceUuids && f.serviceUuids.length) {
            const advU = (adv.serviceUuids || []).map(normalizeUuid);
            const want = f.serviceUuids.map(normalizeUuid);
            if (!want.some(w => advU.includes(w))) {
                return false;
            }
        }
        if (f.namePrefixes && f.namePrefixes.length) {
            if (!matchesPrefix(adv.localName || '', f.namePrefixes)) {
                return false;
            }
        }
        if (f.manufacturerId !== undefined) {
            const md = adv.manufacturerData;
            if (!md || md.length < 2 || md.readUInt16LE(0) !== f.manufacturerId) {
                return false;
            }
        }
        return true;
    }
    deliver(sub, adv, ts) {
        const packet = {
            subscriptionId: sub.subscriptionId,
            address: adv.address,
            addressType: adv.addressType,
            rssi: adv.rssi,
            ts,
        };
        if (adv.localName) {
            packet.localName = adv.localName;
        }
        if (adv.txPowerLevel !== undefined) {
            packet.txPowerLevel = adv.txPowerLevel;
        }
        if (adv.serviceUuids) {
            packet.serviceUuids = adv.serviceUuids;
        }
        if (adv.manufacturerData) {
            packet.manufacturerData = adv.manufacturerData.toString('hex');
        }
        if (adv.serviceData) {
            packet.serviceData = adv.serviceData.map(sd => ({ uuid: sd.uuid, data: sd.data.toString('hex') }));
        }
        // Fire-and-forget push; no callback. The subscriber handles 'blePacket'.
        this.sendTo(sub.subscriberId, 'blePacket', packet);
    }
    // ---- message router ---------------------------------------------------
    async onAdapterMessage(obj) {
        if (!obj?.command) {
            return;
        }
        switch (obj.command) {
            case 'subscribe':
                await this.handleSubscribe(obj);
                break;
            case 'unsubscribe':
                await this.handleUnsubscribe(obj);
                break;
            case 'getStatus':
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, {
                        controller: this.controllerInfo(),
                        subscribers: new Set([...this.subscriptions.values()].map(s => s.subscriberId)).size,
                        subscriptions: [...this.subscriptions.values()].map(s => ({
                            subscriber: s.subscriberId,
                            subscriptionId: s.subscriptionId,
                            filter: s.filter,
                        })),
                    }, obj.callback);
                }
                break;
            case 'scan':
                await this.handleDiagnosticScan(obj);
                break;
            case 'listHciAdapters': {
                let adapters = await listHciAdapters();
                if (!adapters.length) {
                    adapters = [
                        { value: 0, label: 'hci0' },
                        { value: 1, label: 'hci1' },
                    ];
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, adapters, obj.callback);
                }
                break;
            }
        }
    }
    // Extract the instance id (e.g. "wattcycle.0") from a message `from` field.
    subscriberIdFrom(from) {
        return from.startsWith(ALIVE_PREFIX) ? from.slice(ALIVE_PREFIX.length) : from;
    }
    async handleSubscribe(obj) {
        const reply = (payload) => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };
        const msg = obj.message || {};
        if (!msg.subscriptionId) {
            reply({ error: 'subscriptionId is required' });
            return;
        }
        const subscriberId = this.subscriberIdFrom(obj.from);
        const filter = msg.filter || {};
        if (filter.macs) {
            filter.macs = filter.macs.map(m => m.toLowerCase());
        }
        if (isEmptyFilter(filter)) {
            this.log.warn(`Subscription ${subscriberId}::${msg.subscriptionId} has an empty filter — receives ALL devices`);
        }
        try {
            const hci = await resolveHciId(this.config.hciDevice);
            if (hci < 0) {
                const adapters = await readHciAdapters();
                throw new Error(`Configured controller ${String(this.config.hciDevice)} not present. ` +
                    `Available: ${adapters.map(a => `hci${a.id}=${a.address || '?'}`).join(', ') || 'none'}`);
            }
            await this.ensureNoble(hci);
            await this.ensureScanning();
        }
        catch (e) {
            this.log.error(`subscribe failed for ${subscriberId}: ${e.message}`);
            reply({ error: e.message });
            return;
        }
        const minIntervalMs = Math.max(0, parseInt(msg.minIntervalMs, 10) || 0);
        const key = `${subscriberId}::${msg.subscriptionId}`;
        this.subscriptions.set(key, {
            subscriberId,
            subscriptionId: msg.subscriptionId,
            filter,
            minIntervalMs,
            lastSent: new Map(),
        });
        await this.watchAlive(subscriberId);
        await this.setStateAsync('info.connection', true, true);
        await this.updateInfoStates();
        this.log.info(`Subscribed ${key} (filter: ${JSON.stringify(filter)})`);
        reply({ ok: true, controller: this.controllerInfo() });
    }
    async handleUnsubscribe(obj) {
        const subscriberId = this.subscriberIdFrom(obj.from);
        const msg = obj.message || {};
        if (msg.subscriptionId) {
            const key = `${subscriberId}::${msg.subscriptionId}`;
            this.subscriptions.delete(key);
            if (!this.hasSubscriber(subscriberId)) {
                await this.unwatchAlive(subscriberId);
            }
            await this.updateInfoStates();
            await this.maybeStopScanning();
            this.log.info(`Unsubscribed ${key}`);
        }
        else {
            await this.removeSubscriptionsFor(subscriberId);
            this.log.info(`Unsubscribed all of ${subscriberId}`);
        }
        if (obj.callback) {
            this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
        }
    }
    async handleDiagnosticScan(obj) {
        const reply = (payload) => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };
        const msg = obj.message || {};
        const ms = parseInt(msg.duration, 10) ||
            parseInt(this.config.scanDurationMs, 10) ||
            8000;
        const prefixes = parsePrefixes(typeof msg.namePrefixes === 'string' ? msg.namePrefixes : undefined);
        const targetHci = msg.hciDevice !== undefined && msg.hciDevice !== ''
            ? await resolveHciId(msg.hciDevice)
            : await resolveHciId(this.config.hciDevice);
        if (targetHci < 0) {
            reply({ error: `Controller ${String(msg.hciDevice ?? this.config.hciDevice)} not present on this host` });
            return;
        }
        if (this.diag) {
            reply({ error: 'A diagnostic scan is already running' });
            return;
        }
        const startedForDiag = !this.scanner?.isScanning();
        try {
            await this.ensureNoble(targetHci);
            this.diag = new Map();
            await this.ensureScanning();
            this.log.info(`Diagnostic scan on hci${this.currentHci} for ${ms} ms...`);
            await sleep(ms);
            const list = [...this.diag.values()]
                .filter(d => matchesPrefix(d.localName, prefixes))
                .sort((a, b) => b.rssi - a.rssi);
            this.diag = null;
            if (startedForDiag && this.subscriptions.size === 0) {
                await this.scanner?.stop();
            }
            this.log.info(`Diagnostic scan finished: ${list.length} device(s)`);
            reply(list);
        }
        catch (e) {
            this.diag = null;
            if (startedForDiag && this.subscriptions.size === 0) {
                await this.scanner?.stop().catch(() => undefined);
            }
            reply({ error: e.message });
        }
    }
}
if (require.main !== module) {
    module.exports = (options) => new BleGatewayAdapter(options);
}
else {
    (() => new BleGatewayAdapter())();
}
//# sourceMappingURL=main.js.map