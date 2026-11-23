"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const adapter_core_1 = require("@iobroker/adapter-core");
const node_fs_1 = require("node:fs");
const scanner_1 = require("./lib/scanner");
const hci_info_1 = require("./lib/hci-info");
const gatt_proxy_1 = require("./lib/gatt-proxy");
const uuid_1 = require("./lib/uuid");
const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i;
const ALIVE_PREFIX = 'system.adapter.';
const ALIVE_SUFFIX = '.alive';
// A peripheral seen this recently can be connected without scanning for it first.
const PERIPHERAL_FRESH_MS = 30000;
// A running scan without a single advertisement for this long is restarted.
const SCAN_SILENCE_MS = 60000;
// A controller that stays lost this long makes the adapter restart itself.
const POWER_LOSS_RESTART_MS = 15000;
const GATT_COMMANDS = new Set([
    'gattConnect',
    'gattSubscribe',
    'gattUnsubscribe',
    'gattWrite',
    'gattRead',
    'gattDisconnect',
]);
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
        // The HCI probe can come back empty on a transient failure (no
        // Command Complete within the timeout); the sysfs fallback then has no
        // MACs on recent kernels. Probe once more before giving up.
        for (let attempt = 0; attempt < 2; attempt++) {
            const adapters = await readHciAdapters();
            const match = adapters.find(a => a.address === wanted);
            if (match) {
                return match.id;
            }
            if (attempt === 0) {
                await new Promise(r => setTimeout(r, 300));
            }
        }
        return -1;
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
    // Pending wait for noble's `poweredOn`, shared by concurrent ensureNoble() callers.
    poweringOn = null;
    stopping = false;
    // Recovery of a lost controller (see handlePowerState).
    wasPoweredOn = false;
    powerLossTimer = null;
    sawAdvertisement = false;
    scanRestartedAt = 0;
    // key = `${subscriberId}::${subscriptionId}`
    subscriptions = new Map();
    // subscriberIds whose `.alive` foreign state we currently watch
    watchedAlive = new Set();
    // Active diagnostic-scan collector (admin "scan" button); null when idle.
    diag = null;
    // GATT connections on behalf of other instances.
    gatt;
    // Last noble peripheral object and time seen, per lowercased MAC (for gattConnect).
    peripherals = new Map();
    // gattConnect calls waiting for a device to advertise, per lowercased MAC.
    discoveries = new Map();
    pruneTimer = null;
    scanSilenceWarned = false;
    constructor(options = {}) {
        super({
            ...options,
            name: 'ble-gateway',
            unload: cb => this.onUnload(cb),
            message: obj => this.onAdapterMessage(obj),
            stateChange: (id, state) => this.onStateChange(id, state),
            ready: () => this.onReady(),
        });
        this.gatt = new gatt_proxy_1.GattProxy({
            // this.log is only set once the adapter has connected — resolve it per call.
            log: {
                info: m => this.log.info(m),
                warn: m => this.log.warn(m),
                error: m => this.log.error(m),
                debug: m => this.log.debug(m),
            },
            findPeripheral: (address, timeoutMs) => this.findPeripheral(address, timeoutMs),
            suspendScan: () => this.scanner?.suspend() ?? Promise.resolve(),
            resumeScan: () => this.scanner?.resume() ?? Promise.resolve(),
            send: (instance, command, message) => this.sendTo(instance, command, message),
            onChange: () => {
                if (!this.stopping) {
                    void this.setStateAsync('info.connections', this.gatt.size, true).catch(() => undefined);
                }
            },
        });
    }
    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        await this.setStateAsync('info.subscribers', 0, true);
        await this.setStateAsync('info.subscriptions', '[]', true);
        await this.setStateAsync('info.connections', 0, true);
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
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        if (this.powerLossTimer) {
            clearTimeout(this.powerLossTimer);
            this.powerLossTimer = null;
        }
        const finish = () => {
            try {
                cb();
            }
            catch {
                // ignore
            }
        };
        // Stop the scan first, so the GATT pause ending in disconnectAll() does not restart it.
        void Promise.resolve(this.scanner?.stop())
            .catch(() => undefined)
            .then(() => this.gatt.disconnectAll())
            .catch(() => undefined)
            .finally(finish);
    }
    onStateChange(id, state) {
        if (!id.startsWith(ALIVE_PREFIX) || !id.endsWith(ALIVE_SUFFIX)) {
            return;
        }
        const clientId = id.slice(ALIVE_PREFIX.length, id.length - ALIVE_SUFFIX.length);
        // alive removed (null) or turned false → the client is gone.
        if (!state || state.val === false) {
            void this.dropClient(clientId);
        }
    }
    // Forget everything an instance had: subscriptions and GATT connections.
    async dropClient(clientId) {
        if (this.hasSubscriber(clientId)) {
            this.log.info(`Subscriber ${clientId} is no longer alive — dropping its subscriptions`);
            await this.removeSubscriptionsFor(clientId);
        }
        const closed = await this.gatt.dropOwner(clientId);
        if (closed) {
            this.log.info(`${clientId} is no longer alive — closed its ${closed} GATT connection(s)`);
        }
        await this.maybeUnwatch(clientId);
    }
    // ---- noble / scanner lifecycle ---------------------------------------
    // Create noble for `hciId` (once per process) and wait until the controller
    // is powered on. Safe to call concurrently: every caller resolves only after
    // `poweredOn`, not merely after the noble instance exists.
    async ensureNoble(hciId) {
        if (this.noble && this.currentHci !== hciId) {
            // The @stoprocent/noble HCI binding holds native socket state that
            // cannot be cleanly reset in-process. Switching controllers requires
            // a process restart.
            throw new Error(`Cannot switch to hci${hciId} in-process — please restart the adapter to apply the change.`);
        }
        if (!this.noble) {
            process.env.NOBLE_HCI_DEVICE_ID = String(hciId);
            const nobleModule = require('@stoprocent/noble');
            try {
                this.noble = nobleModule.withBindings('hci', { deviceId: hciId });
            }
            catch {
                this.noble = nobleModule.withBindings ? nobleModule.withBindings('hci') : nobleModule;
            }
            this.currentHci = hciId;
            this.noble.on?.('stateChange', (state) => this.handlePowerState(state));
            this.scanner = new scanner_1.BleScanner(this.noble, {
                info: m => this.log.info(m),
                warn: m => this.log.warn(m),
                error: m => this.log.error(m),
                debug: m => this.log.debug(m),
            });
            // Forget peripherals not seen for a while (random addresses rotate,
            // so the cache would otherwise grow forever).
            this.pruneTimer = setInterval(() => {
                const limit = Date.now() - 2 * PERIPHERAL_FRESH_MS;
                for (const [address, entry] of this.peripherals) {
                    if (entry.lastSeen < limit) {
                        this.peripherals.delete(address);
                    }
                }
                this.checkScanAlive();
            }, PERIPHERAL_FRESH_MS);
        }
        const scanner = this.scanner;
        if (scanner.isPoweredOn()) {
            return;
        }
        // Not (or no longer) powered on: wait. A failed wait is not cached, so
        // the next caller waits again instead of passing an unpowered controller.
        if (!this.poweringOn) {
            this.poweringOn = scanner
                .waitPoweredOn(15000)
                .then(() => this.log.info(`Bluetooth controller hci${hciId} powered on`))
                .finally(() => {
                this.poweringOn = null;
            });
        }
        await this.poweringOn;
    }
    // Start scanning if not already running. Caller must have called ensureNoble.
    // No isScanning() shortcut here: a stop may still be queued in the scanner,
    // and start() is a no-op anyway when the scan is already running.
    async ensureScanning() {
        if (!this.scanner) {
            throw new Error('BLE not initialised');
        }
        await this.scanner.start((adv, peripheral) => this.handleAdvertisement(adv, peripheral));
    }
    // Anything that needs advertisements right now: subscribers, the
    // diagnostic scan, or a gattConnect waiting for its device to show up.
    needsScan() {
        return this.subscriptions.size > 0 || !!this.diag || this.discoveries.size > 0;
    }
    // Stop scanning when nothing needs the controller any more. Not gated on
    // isScanning(): a start may still be pending, and stop() is queued behind it.
    async maybeStopScanning() {
        if (!this.needsScan() && this.scanner) {
            await this.scanner.stop();
            await this.setStateAsync('info.connection', false, true);
        }
    }
    // Resolve the configured (or given) controller to its current hciX id.
    async resolveController(value = this.config.hciDevice) {
        // Once noble runs on the configured controller, do not probe the HCI
        // devices again: the probe opens raw sockets next to noble's and takes
        // ~2 s — too much for every gattConnect and subscribe.
        if (this.noble && this.currentHci >= 0 && String(value) === String(this.config.hciDevice)) {
            return this.currentHci;
        }
        const hci = await resolveHciId(value);
        if (hci < 0) {
            const adapters = await readHciAdapters();
            throw new Error(`Configured controller ${String(value)} not present. ` +
                `Available: ${adapters.map(a => `hci${a.id}=${a.address || '?'}`).join(', ') || 'none'}`);
        }
        return hci;
    }
    // Resolve the controller and make sure noble runs (powered on) on it.
    async openController(value) {
        const hci = await this.resolveController(value);
        await this.ensureNoble(hci);
        return hci;
    }
    // The noble peripheral for a MAC: from the cache if seen recently, otherwise
    // scan until the device advertises (or the timeout hits).
    findPeripheral(address, timeoutMs) {
        const cached = this.peripherals.get(address);
        if (cached && Date.now() - cached.lastSeen < PERIPHERAL_FRESH_MS) {
            return Promise.resolve(cached.peripheral);
        }
        return new Promise((resolve, reject) => {
            let waiters = this.discoveries.get(address);
            if (!waiters) {
                waiters = new Set();
                this.discoveries.set(address, waiters);
            }
            const own = {};
            const done = () => {
                clearTimeout(own.timer);
                if (own.waiter) {
                    waiters.delete(own.waiter);
                }
                if (!waiters.size && this.discoveries.get(address) === waiters) {
                    this.discoveries.delete(address);
                }
                // Drop the scan again if only this discovery wanted it.
                void this.maybeStopScanning().catch(() => undefined);
            };
            own.waiter = (peripheral) => {
                done();
                resolve(peripheral);
            };
            own.timer = setTimeout(() => {
                done();
                reject(new Error(`${address} not seen within ${timeoutMs} ms`));
            }, timeoutMs);
            waiters.add(own.waiter);
            this.ensureScanning().catch(e => {
                done();
                reject(e instanceof Error ? e : new Error(String(e)));
            });
        });
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
    // Stop watching an instance once it has neither subscriptions nor GATT connections.
    async maybeUnwatch(clientId) {
        if (!this.hasSubscriber(clientId) && !this.gatt.hasOwner(clientId)) {
            await this.unwatchAlive(clientId);
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
            await this.maybeUnwatch(subscriberId);
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
    // A controller can drop off while in use: USB dongles re-enumerate after a
    // firmware hang, often under a new hciX. noble cannot re-open a controller
    // in-process, so if it stays lost the adapter restarts itself — and on
    // start resolves the configured MAC to its current hciX again.
    handlePowerState(state) {
        if (state === 'poweredOn') {
            this.wasPoweredOn = true;
            if (this.powerLossTimer) {
                clearTimeout(this.powerLossTimer);
                this.powerLossTimer = null;
                this.log.info(`Bluetooth controller hci${this.currentHci} is back`);
            }
            return;
        }
        if (!this.wasPoweredOn || this.powerLossTimer || this.stopping) {
            return;
        }
        this.log.warn(`Bluetooth controller hci${this.currentHci} is ${state} — restarting the adapter ` +
            `if it is not back within ${POWER_LOSS_RESTART_MS / 1000} s`);
        void this.setStateAsync('info.connection', false, true).catch(() => undefined);
        this.powerLossTimer = setTimeout(() => {
            this.powerLossTimer = null;
            void this.restartForController(`controller hci${this.currentHci} is ${state}`);
        }, POWER_LOSS_RESTART_MS);
    }
    async restartForController(reason) {
        if (this.stopping) {
            return;
        }
        let moved = '';
        try {
            const hci = await resolveHciId(this.config.hciDevice);
            if (hci >= 0 && hci !== this.currentHci) {
                moved = ` (${String(this.config.hciDevice)} is now hci${hci})`;
            }
        }
        catch {
            // only for the message
        }
        if (this.stopping) {
            return;
        }
        this.log.error(`Bluetooth ${reason}${moved} — restarting the adapter to open it again`);
        if (typeof this.terminate === 'function') {
            this.terminate(`Bluetooth ${reason}`, adapter_core_1.EXIT_CODES.START_IMMEDIATELY_AFTER_STOP);
        }
    }
    // Watchdog: the controller can refuse "scan enable" while noble believes it
    // scans — then nothing arrives at all, for every subscriber. Restart the
    // scan; if that does not help either (and devices were seen before, so the
    // air is not simply empty), restart the adapter.
    checkScanAlive() {
        const silent = this.scanner?.silentMs() ?? 0;
        if (silent < SCAN_SILENCE_MS || this.stopping) {
            return;
        }
        if (this.scanRestartedAt && this.sawAdvertisement) {
            void this.restartForController(`scan delivers no advertisements for ${Math.round(silent / 1000)} s`);
            return;
        }
        this.scanRestartedAt = Date.now();
        const msg = `No BLE advertisement for ${Math.round(silent / 1000)} s — restarting the scan`;
        if (this.scanSilenceWarned) {
            this.log.debug(msg);
        }
        else {
            this.log.warn(msg);
            this.scanSilenceWarned = true;
        }
        void this.scanner?.restart().catch(e => this.log.debug(`Scan restart failed: ${e.message}`));
    }
    handleAdvertisement(adv, peripheral) {
        this.scanSilenceWarned = false;
        this.sawAdvertisement = true;
        this.scanRestartedAt = 0;
        if (peripheral) {
            this.peripherals.set(adv.address, { peripheral, lastSeen: Date.now() });
            const waiters = this.discoveries.get(adv.address);
            if (waiters) {
                for (const waiter of [...waiters]) {
                    waiter(peripheral);
                }
            }
        }
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
            // Like noble's own scan filter: advertised service UUIDs and the
            // UUIDs of service data both count (BTHome, Xiaomi, ... only send
            // service data).
            const advU = [...(adv.serviceUuids || []), ...(adv.serviceData || []).map(sd => sd.uuid)].map(uuid_1.normalizeUuid);
            const want = f.serviceUuids.map(uuid_1.normalizeUuid);
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
        if (adv.connectable !== undefined) {
            packet.connectable = adv.connectable;
        }
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
        if (GATT_COMMANDS.has(obj.command)) {
            await this.handleGatt(obj);
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
                        connections: this.gatt.list(),
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
    // ---- GATT proxy -------------------------------------------------------
    async handleGatt(obj) {
        const owner = this.subscriberIdFrom(obj.from);
        const reply = (payload) => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };
        const msg = (obj.message || {});
        try {
            let result = { ok: true };
            switch (obj.command) {
                case 'gattConnect': {
                    await this.openController();
                    // Watch first, so a client dying mid-connect is still noticed.
                    await this.watchAlive(owner);
                    try {
                        const r = await this.gatt.connect(owner, msg);
                        result = { ok: true, ...r };
                    }
                    finally {
                        await this.maybeUnwatch(owner);
                    }
                    break;
                }
                case 'gattSubscribe':
                    await this.gatt.subscribe(owner, msg);
                    break;
                case 'gattUnsubscribe':
                    await this.gatt.unsubscribe(owner, msg);
                    break;
                case 'gattWrite':
                    await this.gatt.write(owner, msg);
                    break;
                case 'gattRead':
                    result = { ok: true, data: await this.gatt.read(owner, msg) };
                    break;
                case 'gattDisconnect':
                    await this.gatt.disconnect(owner, msg.connectionId);
                    await this.maybeUnwatch(owner);
                    break;
            }
            reply(result);
        }
        catch (e) {
            const message = e.message || String(e);
            // Offline devices are normal for clients — they decide what to log.
            this.log.debug(`${obj.command} from ${owner} failed: ${message}`);
            reply({ error: message });
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
        const minIntervalMs = Math.max(0, parseInt(msg.minIntervalMs, 10) || 0);
        const key = `${subscriberId}::${msg.subscriptionId}`;
        const previous = this.subscriptions.get(key);
        let registered = false;
        try {
            const hci = await this.resolveController();
            // Register before starting the scan, so an unsubscribe of another
            // subscriber that runs in the meantime sees us and does not stop
            // the scan we are about to rely on.
            this.subscriptions.set(key, {
                subscriberId,
                subscriptionId: msg.subscriptionId,
                filter,
                minIntervalMs,
                lastSent: new Map(),
            });
            registered = true;
            await this.ensureNoble(hci);
            await this.ensureScanning();
        }
        catch (e) {
            if (registered) {
                if (previous) {
                    this.subscriptions.set(key, previous);
                }
                else {
                    this.subscriptions.delete(key);
                }
                await this.maybeStopScanning().catch(() => undefined);
            }
            this.log.error(`subscribe failed for ${subscriberId}: ${e.message}`);
            reply({ error: e.message });
            return;
        }
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
            await this.maybeUnwatch(subscriberId);
            await this.updateInfoStates();
            await this.maybeStopScanning();
            this.log.info(`Unsubscribed ${key}`);
        }
        else {
            // "Everything of mine" — the client is shutting down, so its GATT
            // connections go too.
            await this.removeSubscriptionsFor(subscriberId);
            const closed = await this.gatt.dropOwner(subscriberId);
            await this.maybeUnwatch(subscriberId);
            this.log.info(`Unsubscribed all of ${subscriberId}${closed ? ` and closed ${closed} GATT connection(s)` : ''}`);
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
        if (this.diag) {
            reply({ error: 'A diagnostic scan is already running' });
            return;
        }
        // Claim the slot before the first await, so a second scan request
        // arriving meanwhile is rejected instead of running in parallel.
        const diag = new Map();
        this.diag = diag;
        try {
            await this.openController(msg.hciDevice !== undefined && msg.hciDevice !== '' ? msg.hciDevice : this.config.hciDevice);
            await this.ensureScanning();
            this.log.info(`Diagnostic scan on hci${this.currentHci} for ${ms} ms...`);
            await sleep(ms);
            const list = [...diag.values()]
                .filter(d => matchesPrefix(d.localName, prefixes))
                .sort((a, b) => b.rssi - a.rssi);
            this.diag = null;
            // Stops only if no subscriber needs the scan — also covers the
            // last subscriber leaving while the diagnostic scan was running.
            await this.maybeStopScanning();
            this.log.info(`Diagnostic scan finished: ${list.length} device(s)`);
            reply(list);
        }
        catch (e) {
            this.diag = null;
            await this.maybeStopScanning().catch(() => undefined);
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