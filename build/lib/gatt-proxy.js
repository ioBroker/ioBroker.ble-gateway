"use strict";
// GATT proxy: lets other adapters use GATT connections (connect, read, write,
// notify) on the controller owned by the gateway, via messages.
//
// Every connection belongs to the instance that opened it ("owner"); only the
// owner may use it, and all its connections are closed when it dies. Connects
// run one at a time, and the gateway pauses the scan for them itself: noble's
// connect() stops a running scan and never restarts it.
//
// The pause covers a whole session, not each connect: it starts before the
// first connect and ends 1.5 s after the last connection closed (or after at
// most 15 s, so long-lived connections do not starve the subscribers). Cheap
// USB controllers (e.g. Realtek RTL8761B) crash and re-enumerate when the scan
// is toggled around every connect while advertisements flood in; one pause
// per session plus a short settle time before connecting is much gentler.
Object.defineProperty(exports, "__esModule", { value: true });
exports.GattProxy = void 0;
const uuid_1 = require("./uuid");
const DEFAULT_DISCOVER_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const SERVICES_TIMEOUT_MS = 10000;
const OP_TIMEOUT_MS = 5000;
const DISCONNECT_TIMEOUT_MS = 5000;
const DEFAULT_SCAN_PAUSE = { settleMs: 300, releaseDelayMs: 1500, maxHoldMs: 15000 };
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(p, ms, msg, onTimeout) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            try {
                onTimeout?.();
            }
            catch {
                // ignore
            }
            reject(new Error(msg));
        }, ms);
        p.then(v => {
            clearTimeout(t);
            resolve(v);
        }, e => {
            clearTimeout(t);
            reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
}
function clampMs(value, def, max) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}
class GattProxy {
    host;
    connections = new Map();
    connectLock = Promise.resolve();
    // Addresses with a connect in flight, so two connects to one device cannot race.
    connecting = new Set();
    counter = 0;
    timing;
    // Scan pause for the current GATT session.
    holding = false;
    holdSince = 0;
    releaseTimer = null;
    constructor(host, timing = {}) {
        this.host = host;
        this.timing = { ...DEFAULT_SCAN_PAUSE, ...timing };
    }
    /** True while the proxy keeps the scan paused. */
    isHoldingScan() {
        return this.holding;
    }
    get size() {
        return this.connections.size;
    }
    hasOwner(owner) {
        for (const c of this.connections.values()) {
            if (c.owner === owner) {
                return true;
            }
        }
        return false;
    }
    list() {
        return [...this.connections.values()].map(c => ({
            connectionId: c.id,
            owner: c.owner,
            address: c.address,
            since: c.since,
        }));
    }
    async connect(owner, payload) {
        const address = String(payload?.address || '')
            .trim()
            .toLowerCase();
        if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(address)) {
            throw new Error(`Invalid address "${String(payload?.address)}"`);
        }
        const discoverMs = clampMs(payload.discoverTimeoutMs, DEFAULT_DISCOVER_TIMEOUT_MS, 60000);
        const connectMs = clampMs(payload.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 60000);
        if (this.connecting.has(address)) {
            throw new Error(`A connect to ${address} is already in progress`);
        }
        this.connecting.add(address);
        try {
            for (const c of [...this.connections.values()]) {
                if (c.address !== address) {
                    continue;
                }
                if (c.owner !== owner) {
                    throw new Error(`${address} is already connected by ${c.owner}`);
                }
                // Same owner, stale connection (e.g. a lost disconnect) — replace it.
                this.host.log.debug(`gatt: ${owner} reconnects ${address}, closing ${c.id} first`);
                await this.close(c, true);
            }
            const found = this.host.findPeripheral(address, discoverMs);
            // Not in the cache: the device is searched by scanning, so a pause
            // held for a previous connect must end now.
            const quick = await Promise.race([
                found.then(() => true, () => true),
                sleep(100).then(() => false),
            ]);
            if (!quick) {
                this.releaseScanNow();
            }
            const peripheral = await found;
            // One connect at a time, with the scan paused (see the header).
            const run = async () => {
                await this.holdScan();
                try {
                    return await this.doConnect(owner, address, peripheral, connectMs);
                }
                finally {
                    this.releaseScanSoon();
                }
            };
            const result = this.connectLock.then(run, run);
            this.connectLock = result.catch(() => undefined);
            return await result;
        }
        finally {
            this.connecting.delete(address);
        }
    }
    async doConnect(owner, address, peripheral, connectMs) {
        this.host.log.debug(`gatt: ${owner} connecting ${address}...`);
        await withTimeout(Promise.resolve(peripheral.connectAsync()), connectMs, `Connect timeout for ${address}`, () => peripheral.cancelConnect?.());
        let discovered;
        try {
            discovered = await withTimeout(Promise.resolve(peripheral.discoverAllServicesAndCharacteristicsAsync()), SERVICES_TIMEOUT_MS, `Service discovery timeout for ${address}`);
        }
        catch (e) {
            await withTimeout(Promise.resolve(peripheral.disconnectAsync()), DISCONNECT_TIMEOUT_MS, 'disconnect timeout').catch(() => undefined);
            throw e;
        }
        const id = `gatt${++this.counter}`;
        const characteristics = [];
        const chars = new Map();
        for (const ch of discovered?.characteristics || []) {
            const uuid = (0, uuid_1.normalizeUuid)(String(ch.uuid));
            const serviceUuid = (0, uuid_1.normalizeUuid)(String(ch._serviceUuid || ''));
            characteristics.push({
                serviceUuid,
                uuid,
                properties: Array.isArray(ch.properties) ? ch.properties : [],
            });
            chars.set(`${serviceUuid}/${uuid}`, ch);
            if (!chars.has(uuid)) {
                chars.set(uuid, ch);
            }
        }
        const conn = {
            id,
            owner,
            address,
            peripheral,
            characteristics,
            chars,
            listeners: new Map(),
            onDisconnect: (reason) => this.handleLinkLoss(conn, reason),
            ops: Promise.resolve(),
            closed: false,
            since: Date.now(),
        };
        peripheral.once('disconnect', conn.onDisconnect);
        this.connections.set(id, conn);
        this.host.onChange();
        this.host.log.debug(`gatt: ${owner} connected ${address} as ${id} (${characteristics.length} characteristics)`);
        return { connectionId: id, address, characteristics };
    }
    subscribe(owner, p) {
        return this.op(owner, p, async (conn, ch, key) => {
            if (!conn.listeners.has(key)) {
                const listener = (data, isNotification) => {
                    // 'data' also fires for read responses — only forward notifications.
                    if (!isNotification || conn.closed) {
                        return;
                    }
                    this.host.send(conn.owner, 'gattNotify', {
                        connectionId: conn.id,
                        service: (0, uuid_1.normalizeUuid)(String(ch._serviceUuid || '')),
                        characteristic: (0, uuid_1.normalizeUuid)(String(ch.uuid)),
                        data: Buffer.isBuffer(data) ? data.toString('hex') : '',
                    });
                };
                ch.on('data', listener);
                conn.listeners.set(key, listener);
            }
            await withTimeout(Promise.resolve(ch.subscribeAsync()), OP_TIMEOUT_MS, `Subscribe timeout on ${key}`);
        });
    }
    unsubscribe(owner, p) {
        return this.op(owner, p, async (conn, ch, key) => {
            const listener = conn.listeners.get(key);
            if (listener) {
                ch.removeListener('data', listener);
                conn.listeners.delete(key);
            }
            await withTimeout(Promise.resolve(ch.unsubscribeAsync()), OP_TIMEOUT_MS, `Unsubscribe timeout on ${key}`);
        });
    }
    write(owner, p) {
        const hex = String(p?.data ?? '');
        if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
            return Promise.reject(new Error('data must be a HEX string'));
        }
        return this.op(owner, p, async (_conn, ch, key) => {
            await withTimeout(Promise.resolve(ch.writeAsync(Buffer.from(hex, 'hex'), !!p.withoutResponse)), OP_TIMEOUT_MS, `Write timeout on ${key}`);
        });
    }
    read(owner, p) {
        return this.op(owner, p, async (_conn, ch, key) => {
            const data = await withTimeout(Promise.resolve(ch.readAsync()), OP_TIMEOUT_MS, `Read timeout on ${key}`);
            return Buffer.isBuffer(data) ? data.toString('hex') : '';
        });
    }
    async disconnect(owner, connectionId) {
        const conn = this.getConn(owner, connectionId);
        await this.close(conn, true);
    }
    /** Close every connection of an instance (it died or unsubscribed everything). */
    async dropOwner(owner) {
        const mine = [...this.connections.values()].filter(c => c.owner === owner);
        for (const c of mine) {
            await this.close(c, true);
        }
        return mine.length;
    }
    async disconnectAll() {
        await Promise.all([...this.connections.values()].map(c => this.close(c, true)));
        this.releaseScanNow();
    }
    // --- internals ---------------------------------------------------------
    // Pause the scan for GATT work, or extend the running pause.
    async holdScan() {
        if (this.releaseTimer) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
        if (this.holding) {
            return;
        }
        this.holding = true;
        this.holdSince = Date.now();
        await this.host.suspendScan();
        // Let the controller drain queued advertising reports before connecting.
        await sleep(this.timing.settleMs);
    }
    releaseScanNow() {
        if (!this.holding) {
            return;
        }
        if (this.releaseTimer) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
        this.holding = false;
        void this.host.resumeScan().catch(e => this.host.log.debug(`gatt: resume scan: ${e}`));
    }
    // End the pause once no connection is open any more (after a short delay,
    // so back-to-back connects share one pause), or when it lasted too long.
    releaseScanSoon() {
        if (!this.holding) {
            return;
        }
        if (this.releaseTimer) {
            clearTimeout(this.releaseTimer);
            this.releaseTimer = null;
        }
        const held = Date.now() - this.holdSince;
        const delay = this.connections.size
            ? Math.max(0, this.timing.maxHoldMs - held)
            : Math.max(this.timing.releaseDelayMs, 0);
        this.releaseTimer = setTimeout(() => {
            this.releaseTimer = null;
            this.releaseScanNow();
        }, delay);
    }
    getConn(owner, connectionId) {
        const conn = this.connections.get(String(connectionId || ''));
        if (!conn || conn.closed) {
            throw new Error(`Unknown or closed connection "${String(connectionId)}"`);
        }
        if (conn.owner !== owner) {
            throw new Error(`Connection ${conn.id} belongs to ${conn.owner}`);
        }
        return conn;
    }
    op(owner, p, fn) {
        let conn;
        try {
            conn = this.getConn(owner, p?.connectionId);
        }
        catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
        const uuid = (0, uuid_1.normalizeUuid)(String(p.characteristic || ''));
        const key = p.service ? `${(0, uuid_1.normalizeUuid)(p.service)}/${uuid}` : uuid;
        const ch = conn.chars.get(key);
        if (!ch) {
            return Promise.reject(new Error(`Characteristic ${key} not found on ${conn.address}`));
        }
        const run = () => {
            if (conn.closed) {
                return Promise.reject(new Error(`Connection ${conn.id} was closed`));
            }
            return fn(conn, ch, key);
        };
        const result = conn.ops.then(run, run);
        conn.ops = result.catch(() => undefined);
        return result;
    }
    // The link dropped without the owner asking for it.
    handleLinkLoss(conn, reason) {
        if (conn.closed) {
            return;
        }
        this.cleanup(conn);
        this.releaseScanSoon();
        const text = typeof reason === 'string' || typeof reason === 'number' ? String(reason) : JSON.stringify(reason ?? null);
        this.host.log.debug(`gatt: ${conn.address} (${conn.id}) disconnected: ${text}`);
        this.host.send(conn.owner, 'gattDisconnected', {
            connectionId: conn.id,
            address: conn.address,
            reason: text,
        });
    }
    async close(conn, disconnectLink) {
        if (conn.closed) {
            return;
        }
        this.cleanup(conn);
        if (disconnectLink) {
            await withTimeout(Promise.resolve(conn.peripheral.disconnectAsync()), DISCONNECT_TIMEOUT_MS, `Disconnect timeout for ${conn.address}`).catch(e => this.host.log.debug(`gatt: ${e.message}`));
        }
        this.host.log.debug(`gatt: ${conn.owner} closed ${conn.address} (${conn.id})`);
        this.releaseScanSoon();
    }
    cleanup(conn) {
        conn.closed = true;
        try {
            conn.peripheral.removeListener('disconnect', conn.onDisconnect);
        }
        catch {
            // ignore
        }
        for (const [key, listener] of conn.listeners) {
            try {
                conn.chars.get(key)?.removeListener('data', listener);
            }
            catch {
                // ignore
            }
        }
        conn.listeners.clear();
        this.connections.delete(conn.id);
        this.host.onChange();
    }
}
exports.GattProxy = GattProxy;
//# sourceMappingURL=gatt-proxy.js.map