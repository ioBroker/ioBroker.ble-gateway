// ---------------------------------------------------------------------------
// ble-gateway client helper — COPY THIS FILE INTO YOUR OWN ADAPTER.
//
// It lets any ioBroker adapter receive BLE advertisement packets from the
// central `ble-gateway` adapter without owning the HCI controller itself.
//
// Usage in your adapter:
//
//   import { BleGatewayClient } from './lib/ble-gateway-client';
//
//   class MyAdapter extends Adapter {
//       private ble = new BleGatewayClient(this);
//
//       constructor(options) {
//           super({
//               ...options,
//               message:     obj          => this.onMessage(obj),
//               stateChange: (id, state)  => this.ble.handleStateChange(id, state),
//               unload:      cb           => this.onUnload(cb),
//               ready:       ()           => this.onReady(),
//           });
//       }
//
//       async onReady() {
//           await this.ble.subscribe('sensors', { macs: ['aa:bb:cc:dd:ee:ff'] }, packet => {
//               this.log.info(`${packet.address} rssi=${packet.rssi} data=${packet.manufacturerData?.toString('hex')}`);
//           });
//       }
//
//       onMessage(obj) {
//           if (this.ble.handleMessage(obj)) return; // consumed a 'blePacket'
//           // ... your own commands
//       }
//
//       onUnload(cb) {
//           this.ble.destroy().finally(cb);
//       }
//   }
// ---------------------------------------------------------------------------

export interface BleGatewayFilter {
    macs?: string[];
    serviceUuids?: string[];
    namePrefixes?: string[];
    manufacturerId?: number;
}

/** Advertisement packet handed to your callback. Binary fields are Buffers. */
export interface BleGatewayPacket {
    subscriptionId: string;
    address: string;
    addressType: string;
    rssi: number;
    ts: number;
    localName?: string;
    txPowerLevel?: number;
    serviceUuids?: string[];
    manufacturerData?: Buffer;
    serviceData?: { uuid: string; data: Buffer }[];
}

type PacketHandler = (packet: BleGatewayPacket) => void;

interface RawPacket {
    subscriptionId: string;
    address: string;
    addressType: string;
    rssi: number;
    ts: number;
    localName?: string;
    txPowerLevel?: number;
    serviceUuids?: string[];
    manufacturerData?: string;
    serviceData?: { uuid: string; data: string }[];
}

interface Entry {
    filter: BleGatewayFilter;
    minIntervalMs?: number;
    handler: PacketHandler;
}

// Minimal slice of the ioBroker Adapter API this helper needs.
interface AdapterLike {
    log: { info(m: string): void; warn(m: string): void; error(m: string): void; debug(m: string): void };
    sendTo(instance: string, command: string, message: unknown, callback?: (result: unknown) => void): void;
    subscribeForeignStatesAsync(pattern: string): Promise<void>;
    unsubscribeForeignStatesAsync(pattern: string): Promise<void>;
    getForeignStateAsync(id: string): Promise<{ val: unknown } | null | undefined>;
}

export class BleGatewayClient {
    private readonly adapter: AdapterLike;
    private readonly gateway: string;
    private readonly connId: string;
    private readonly entries = new Map<string, Entry>();
    private watching = false;
    private lastConnected = false;

    /**
     * @param adapter your adapter instance (`this`)
     * @param gatewayInstance gateway instance id, default "ble-gateway.0"
     */
    public constructor(adapter: AdapterLike, gatewayInstance = 'ble-gateway.0') {
        this.adapter = adapter;
        this.gateway = gatewayInstance;
        this.connId = `${this.gateway}.info.connection`;
    }

    /**
     * Register (or replace) a subscription and start receiving packets.
     * Re-subscribes automatically if the gateway restarts.
     */
    public async subscribe(
        subscriptionId: string,
        filter: BleGatewayFilter,
        onPacket: PacketHandler,
        minIntervalMs?: number,
    ): Promise<void> {
        this.entries.set(subscriptionId, { filter, minIntervalMs, handler: onPacket });
        await this.ensureWatching();
        await this.sendSubscribe(subscriptionId);
    }

    /** Remove one subscription (or all when no id is given). */
    public async unsubscribe(subscriptionId?: string): Promise<void> {
        if (subscriptionId) {
            this.entries.delete(subscriptionId);
            await this.send('unsubscribe', { subscriptionId });
        } else {
            this.entries.clear();
            await this.send('unsubscribe', {});
        }
    }

    /** Call from your adapter's `message` handler. Returns true if it was a packet for us. */
    public handleMessage(obj: ioBroker.Message | undefined): boolean {
        if (!obj || obj.command !== 'blePacket') {
            return false;
        }
        const raw = obj.message as RawPacket;
        const entry = this.entries.get(raw.subscriptionId);
        if (!entry) {
            return true; // ours by command, but no live handler — swallow it
        }
        entry.handler(this.decode(raw));
        return true;
    }

    /** Call from your adapter's `stateChange` handler so re-subscribe works on gateway restart. */
    public handleStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (id !== this.connId) {
            return;
        }
        const connected = !!state?.val;
        // Re-subscribe on a false→true transition (gateway (re)started).
        if (connected && !this.lastConnected) {
            this.adapter.log.info('ble-gateway came online — re-subscribing');
            for (const id2 of this.entries.keys()) {
                void this.sendSubscribe(id2);
            }
        }
        this.lastConnected = connected;
    }

    /** Unsubscribe everything and stop watching the gateway. Call from onUnload. */
    public async destroy(): Promise<void> {
        try {
            await this.send('unsubscribe', {});
        } catch {
            // ignore
        }
        this.entries.clear();
        if (this.watching) {
            this.watching = false;
            try {
                await this.adapter.unsubscribeForeignStatesAsync(this.connId);
            } catch {
                // ignore
            }
        }
    }

    // --- internals ---------------------------------------------------------

    private async ensureWatching(): Promise<void> {
        if (this.watching) {
            return;
        }
        this.watching = true;
        try {
            await this.adapter.subscribeForeignStatesAsync(this.connId);
            const st = await this.adapter.getForeignStateAsync(this.connId);
            this.lastConnected = !!st?.val;
        } catch (e) {
            this.adapter.log.debug(`ble-gateway watch failed: ${(e as Error).message}`);
        }
    }

    private sendSubscribe(subscriptionId: string): Promise<void> {
        const entry = this.entries.get(subscriptionId);
        if (!entry) {
            return Promise.resolve();
        }
        return new Promise<void>(resolve => {
            this.adapter.sendTo(
                this.gateway,
                'subscribe',
                { subscriptionId, filter: entry.filter, minIntervalMs: entry.minIntervalMs },
                (res: unknown) => {
                    const r = res as { ok?: boolean; error?: string };
                    if (r?.error) {
                        this.adapter.log.warn(`ble-gateway subscribe '${subscriptionId}' failed: ${r.error}`);
                    }
                    resolve();
                },
            );
        });
    }

    private send(command: string, message: unknown): Promise<void> {
        return new Promise<void>(resolve => {
            this.adapter.sendTo(this.gateway, command, message, () => resolve());
        });
    }

    private decode(raw: RawPacket): BleGatewayPacket {
        const out: BleGatewayPacket = {
            subscriptionId: raw.subscriptionId,
            address: raw.address,
            addressType: raw.addressType,
            rssi: raw.rssi,
            ts: raw.ts,
            localName: raw.localName,
            txPowerLevel: raw.txPowerLevel,
            serviceUuids: raw.serviceUuids,
        };
        if (raw.manufacturerData) {
            out.manufacturerData = Buffer.from(raw.manufacturerData, 'hex');
        }
        if (raw.serviceData) {
            out.serviceData = raw.serviceData.map(sd => ({ uuid: sd.uuid, data: Buffer.from(sd.data, 'hex') }));
        }
        return out;
    }
}
