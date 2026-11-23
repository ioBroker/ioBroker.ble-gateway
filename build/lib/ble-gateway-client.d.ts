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
    /** Whether the device accepts connections (advertising type). */
    connectable?: boolean;
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
/** A characteristic of a connected device. UUIDs are lowercase, short form where possible ("fff1"). */
export interface BleGattCharacteristic {
    serviceUuid: string;
    uuid: string;
    /** e.g. ["read", "write", "writeWithoutResponse", "notify"] */
    properties: string[];
}
export interface BleGattConnectOptions {
    /** How long the device may take to show up in the scan (default 15000 ms). */
    discoverTimeoutMs?: number;
    /** How long the link may take to come up (default 15000 ms). */
    connectTimeoutMs?: number;
}
interface AdapterLike {
    log: {
        info(m: string): void;
        warn(m: string): void;
        error(m: string): void;
        debug(m: string): void;
    };
    sendTo(instance: string, command: string, message: unknown, callback?: (result: unknown) => void, options?: {
        timeout?: number;
    }): void;
    subscribeForeignStatesAsync(pattern: string): Promise<void>;
    unsubscribeForeignStatesAsync(pattern: string): Promise<void>;
    getForeignStateAsync(id: string): Promise<{
        val: unknown;
    } | null | undefined>;
}
/** Rejection of `request()` when the gateway did not answer in time. */
export declare class BleGatewayTimeoutError extends Error {
}
/** An open GATT connection held by the gateway on behalf of this adapter. */
export declare class BleGattConnection {
    readonly id: string;
    readonly address: string;
    readonly characteristics: BleGattCharacteristic[];
    private readonly client;
    private readonly notifyHandlers;
    private readonly disconnectHandlers;
    private closed;
    constructor(client: BleGatewayClient, id: string, address: string, characteristics: BleGattCharacteristic[]);
    isOpen(): boolean;
    /** Find a characteristic by UUID (short or long form). */
    findCharacteristic(uuid: string): BleGattCharacteristic | undefined;
    /** Enable notifications; `onData` receives every notified value. */
    subscribe(characteristic: string, onData: (data: Buffer) => void, service?: string): Promise<void>;
    unsubscribe(characteristic: string, service?: string): Promise<void>;
    /** Write a value. `withoutResponse` = write command instead of write request. */
    write(characteristic: string, data: Buffer, withoutResponse?: boolean, service?: string): Promise<void>;
    read(characteristic: string, service?: string): Promise<Buffer>;
    /** Close the link. Safe to call twice or after the link dropped. */
    disconnect(): Promise<void>;
    /** Called when the link drops without disconnect() (device gone, gateway restarted, ...). */
    onDisconnect(cb: (reason: string) => void): void;
    dispatchNotify(characteristic: string, service: string, data: Buffer): void;
    dispatchDisconnect(reason: string): void;
    private key;
}
export declare class BleGatewayClient {
    private readonly adapter;
    private readonly gateway;
    private readonly aliveId;
    private readonly onConnectionChange?;
    private readonly entries;
    private readonly gattConnections;
    private readonly pending;
    private flushTimer;
    private watching;
    private aliveKnown;
    private gatewayAlive;
    private connected;
    private destroyed;
    /**
     * @param adapter your adapter instance (`this`)
     * @param gatewayInstance gateway instance id, default "ble-gateway.0"
     * @param onConnectionChange optional, called with true once the gateway acknowledged a subscription
     *     and with false when the gateway stops or a subscription fails
     */
    constructor(adapter: AdapterLike, gatewayInstance?: string, onConnectionChange?: (connected: boolean) => void);
    /** True while the gateway instance is running (its `alive` state is true). */
    isGatewayAlive(): boolean;
    /**
     * Register (or replace) a subscription and start receiving packets.
     * If the gateway is not running, the subscription is sent as soon as it starts.
     * Re-subscribes automatically if the gateway restarts.
     */
    subscribe(subscriptionId: string, filter: BleGatewayFilter, onPacket: PacketHandler, minIntervalMs?: number): Promise<void>;
    /** Remove one subscription (or all when no id is given). */
    unsubscribe(subscriptionId?: string): Promise<void>;
    /**
     * Open a GATT connection to a device through the gateway. The device must
     * advertise within `discoverTimeoutMs`. Always call `disconnect()` when done.
     */
    gattConnect(address: string, opts?: BleGattConnectOptions): Promise<BleGattConnection>;
    /**
     * Send a command to the gateway and wait for its answer. Rejects if the
     * gateway answers `{ error }` or does not answer within `timeoutMs`.
     */
    request<T = Record<string, unknown>>(command: string, message: unknown, timeoutMs?: number): Promise<T>;
    forget(connectionId: string): void;
    /** Call from your adapter's `message` handler. Returns true if the message was for this helper. */
    handleMessage(obj: ioBroker.Message | undefined): boolean;
    /**
     * Call from your adapter's `stateChange` handler. Watches the gateway's `alive` state:
     * the gateway forgets all subscriptions and GATT connections when it restarts, so
     * subscriptions are sent again as soon as it is back and open connections are
     * reported via `onDisconnect`.
     */
    handleStateChange(id: string, state: ioBroker.State | null | undefined): void;
    /** Unsubscribe everything, close all GATT connections and stop watching the gateway. Call from onUnload. */
    destroy(): Promise<void>;
    private ensureWatching;
    private setConnected;
    private clearFlushTimer;
    /** Send the given subscriptions after `delayMs` (joins an already scheduled send). */
    private queueSubscribe;
    private sendSubscribe;
    private send;
    private decode;
}
export {};
