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
    serviceData?: {
        uuid: string;
        data: Buffer;
    }[];
}
type PacketHandler = (packet: BleGatewayPacket) => void;
interface AdapterLike {
    log: {
        info(m: string): void;
        warn(m: string): void;
        error(m: string): void;
        debug(m: string): void;
    };
    sendTo(instance: string, command: string, message: unknown, callback?: (result: unknown) => void): void;
    subscribeForeignStatesAsync(pattern: string): Promise<void>;
    unsubscribeForeignStatesAsync(pattern: string): Promise<void>;
    getForeignStateAsync(id: string): Promise<{
        val: unknown;
    } | null | undefined>;
}
export declare class BleGatewayClient {
    private readonly adapter;
    private readonly gateway;
    private readonly connId;
    private readonly entries;
    private watching;
    private lastConnected;
    /**
     * @param adapter your adapter instance (`this`)
     * @param gatewayInstance gateway instance id, default "ble-gateway.0"
     */
    constructor(adapter: AdapterLike, gatewayInstance?: string);
    /**
     * Register (or replace) a subscription and start receiving packets.
     * Re-subscribes automatically if the gateway restarts.
     */
    subscribe(subscriptionId: string, filter: BleGatewayFilter, onPacket: PacketHandler, minIntervalMs?: number): Promise<void>;
    /** Remove one subscription (or all when no id is given). */
    unsubscribe(subscriptionId?: string): Promise<void>;
    /** Call from your adapter's `message` handler. Returns true if it was a packet for us. */
    handleMessage(obj: ioBroker.Message | undefined): boolean;
    /** Call from your adapter's `stateChange` handler so re-subscribe works on gateway restart. */
    handleStateChange(id: string, state: ioBroker.State | null | undefined): void;
    /** Unsubscribe everything and stop watching the gateway. Call from onUnload. */
    destroy(): Promise<void>;
    private ensureWatching;
    private sendSubscribe;
    private send;
    private decode;
}
export {};
