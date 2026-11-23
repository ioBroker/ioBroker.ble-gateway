"use strict";
// Generic continuous BLE advertisement scanner — a thin wrapper around
// @stoprocent/noble. Owns nothing battery- or device-specific; it just turns
// the noble `discover` stream into normalised advertisement objects.
//
// noble holds native HCI socket state, so exactly one of these should exist per
// process. Scanning is started lazily by the gateway (only once a subscriber
// exists) and stopped when the last subscriber leaves.
//
// The scanner keeps a *desired* state instead of executing start/stop blindly:
//   scan  ⇔  wanted (start() vs. stop())  &&  not suspended (suspend()/resume())
// Every call queues a reconcile step; the steps run strictly one after another.
// suspend()/resume() exist because noble's connect() stops a running scan and
// never restarts it — the GATT proxy pauses the scan around each connect and
// the scanner brings it back afterwards. If noble stops the scan on its own,
// or the controller comes back after a power loss, the scanner reconciles too.
Object.defineProperty(exports, "__esModule", { value: true });
exports.BleScanner = void 0;
class BleScanner {
    noble;
    log;
    scanning = false;
    wanted = false;
    suspendCount = 0;
    // The last stop was a pause (suspend) — the next start is logged as "resumed".
    pausedLogged = false;
    // Reconcile steps run strictly one after another, so concurrent callers can
    // neither start noble twice nor leave a scan running.
    ops = Promise.resolve();
    onAdv = null;
    onDiscover = null;
    // For the watchdog: when the current scan started and when the last advertisement came.
    scanStartedAt = 0;
    lastAdvAt = 0;
    constructor(noble, log) {
        this.noble = noble;
        this.log = log;
        if (typeof noble?.on === 'function') {
            // noble stops the scan by itself before every connect (and on some
            // controller errors) without telling us — bring it back if wanted.
            noble.on('scanStop', () => this.handleExternalScanStop());
            noble.on('stateChange', (s) => {
                if (s === 'poweredOn') {
                    void this.reconcile();
                }
                else if (this.scanning) {
                    this.scanning = false;
                    this.detachDiscover();
                }
            });
        }
    }
    getPowerState() {
        return this.noble._state || this.noble.state || 'unknown';
    }
    isPoweredOn() {
        return this.getPowerState() === 'poweredOn';
    }
    isScanning() {
        return this.scanning;
    }
    async waitPoweredOn(timeoutMs = 15000) {
        if (typeof this.noble?.on !== 'function') {
            throw new Error('Bluetooth binding not initialised correctly');
        }
        if (this.isPoweredOn()) {
            return;
        }
        await new Promise((resolve, reject) => {
            let onState = null;
            const safeRemove = () => {
                try {
                    if (typeof this.noble.removeListener === 'function' && onState) {
                        this.noble.removeListener('stateChange', onState);
                    }
                }
                catch {
                    // ignore
                }
            };
            const timer = setTimeout(() => {
                safeRemove();
                reject(new Error(`Bluetooth adapter not powered on (state=${this.getPowerState()})`));
            }, timeoutMs);
            onState = (s) => {
                if (s === 'poweredOn') {
                    clearTimeout(timer);
                    safeRemove();
                    resolve();
                }
            };
            try {
                this.noble.on('stateChange', onState);
            }
            catch (e) {
                clearTimeout(timer);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }
    isSuspended() {
        return this.suspendCount > 0;
    }
    /**
     * How long the running scan has delivered no advertisement at all, in ms
     * (0 while not scanning). A controller can refuse "scan enable" while noble
     * still believes it scans — then nothing arrives and only a restart helps.
     */
    silentMs() {
        if (!this.scanning) {
            return 0;
        }
        return Date.now() - Math.max(this.scanStartedAt, this.lastAdvAt);
    }
    /** Stop and start the running scan again (no-op if it is not running). */
    restart() {
        const step = async () => {
            if (this.scanning) {
                await this.doStop();
            }
            await this.sync();
        };
        const run = this.ops.then(step, step);
        this.ops = run.catch(() => undefined);
        return run;
    }
    /**
     * Want continuous scanning. `allowDuplicates=true` so repeated advertisements
     * from the same device keep flowing — essential for streaming sensors/beacons.
     * Resolves once the scan runs (or stays paused while suspended).
     */
    start(onAdvertisement) {
        this.onAdv = onAdvertisement;
        this.wanted = true;
        return this.reconcile();
    }
    /** No longer want scanning. The HCI socket stays bound but idle. */
    stop() {
        this.wanted = false;
        return this.reconcile();
    }
    /** Pause scanning (nestable). Resolves once the scan has actually stopped. */
    suspend() {
        this.suspendCount++;
        return this.reconcile();
    }
    /** Undo one suspend(). Scanning resumes when the last suspend is undone and it is still wanted. */
    resume() {
        if (this.suspendCount > 0) {
            this.suspendCount--;
        }
        return this.reconcile();
    }
    reconcile() {
        // Run after the previous step, whether it succeeded or failed.
        const step = () => this.sync();
        const run = this.ops.then(step, step);
        this.ops = run.catch(() => undefined);
        return run;
    }
    async sync() {
        const shouldScan = this.wanted && this.suspendCount === 0;
        if (shouldScan && !this.scanning) {
            await this.doStart();
        }
        else if (!shouldScan && this.scanning) {
            await this.doStop();
        }
    }
    handleExternalScanStop() {
        if (!this.scanning) {
            return; // our own doStop() — it cleared the flag before stopping
        }
        this.scanning = false;
        this.detachDiscover();
        this.log.debug('BLE scan was stopped by the stack — reconciling');
        void this.reconcile();
    }
    async doStart() {
        if (!this.isPoweredOn()) {
            // No waiting here: that would block every queued step. The
            // stateChange listener reconciles once the controller is back.
            throw new Error(`Bluetooth adapter not powered on (state=${this.getPowerState()})`);
        }
        this.onDiscover = (p) => {
            this.lastAdvAt = Date.now();
            const cb = this.onAdv;
            if (!cb) {
                return;
            }
            const addr = (p.address || '').toLowerCase();
            if (!addr) {
                return;
            }
            const a = p.advertisement || {};
            const serviceData = Array.isArray(a.serviceData)
                ? a.serviceData.map((sd) => ({
                    uuid: String(sd.uuid),
                    data: Buffer.isBuffer(sd.data) ? sd.data : Buffer.from(sd.data || []),
                }))
                : undefined;
            cb({
                address: addr,
                addressType: p.addressType || 'unknown',
                rssi: typeof p.rssi === 'number' ? p.rssi : 0,
                connectable: typeof p.connectable === 'boolean' ? p.connectable : undefined,
                localName: a.localName || undefined,
                txPowerLevel: typeof a.txPowerLevel === 'number' ? a.txPowerLevel : undefined,
                serviceUuids: Array.isArray(a.serviceUuids) && a.serviceUuids.length ? a.serviceUuids : undefined,
                manufacturerData: Buffer.isBuffer(a.manufacturerData) ? a.manufacturerData : undefined,
                serviceData: serviceData && serviceData.length ? serviceData : undefined,
            }, p);
        };
        this.noble.on('discover', this.onDiscover);
        try {
            await this.noble.startScanningAsync([], true);
        }
        catch (e) {
            this.detachDiscover();
            throw e;
        }
        this.scanning = true;
        this.scanStartedAt = Date.now();
        // Pauses around a GATT connect are routine — keep them out of the info log.
        if (this.pausedLogged) {
            this.pausedLogged = false;
            this.log.debug('BLE scan resumed');
        }
        else {
            this.log.info('BLE scan started');
        }
    }
    detachDiscover() {
        if (this.onDiscover) {
            try {
                if (typeof this.noble.removeListener === 'function') {
                    this.noble.removeListener('discover', this.onDiscover);
                }
            }
            catch {
                // ignore — noble may be in a degraded state
            }
            this.onDiscover = null;
        }
    }
    async doStop() {
        this.detachDiscover();
        // Clear the flag before stopping, so our own scanStop event is not
        // mistaken for an external one.
        this.scanning = false;
        try {
            await this.noble.stopScanningAsync();
            if (this.wanted && this.suspendCount > 0) {
                this.pausedLogged = true;
                this.log.debug('BLE scan paused');
            }
            else {
                this.pausedLogged = false;
                this.log.info('BLE scan stopped');
            }
        }
        catch {
            // ignore
        }
    }
}
exports.BleScanner = BleScanner;
//# sourceMappingURL=scanner.js.map