// Shared types for the ble-gateway adapter and its subscriber clients.

/** Adapter instance configuration (admin/jsonConfig.json + io-package.json native). */
export interface BleGatewayAdapterConfig {
    /**
     * HCI device selector. Either a controller MAC (BD_ADDR, e.g. "AA:BB:CC:DD:EE:FF") —
     * stable across reboots — or a numeric hciX index for legacy configs.
     */
    hciDevice: number | string;
    /** Duration (ms) of the one-shot diagnostic scan triggered from the admin UI. */
    scanDurationMs: number | string;
}

/**
 * Advertisement filter. All set criteria are AND-combined; within a single list
 * the match is OR (any entry). An empty filter matches every advertisement.
 */
export interface BleFilter {
    /** Lowercased MAC addresses (the most common case). */
    macs?: string[];
    /** Match if the advertisement exposes any of these (short or long) service UUIDs. */
    serviceUuids?: string[];
    /** Match if the advertised local name starts with any of these (case-insensitive). */
    namePrefixes?: string[];
    /** Match if the manufacturer company id (LE, first two bytes of manufacturerData) equals this. */
    manufacturerId?: number;
}

/**
 * A single advertisement packet delivered to a subscriber via `sendTo(..., 'blePacket', packet)`.
 * Binary fields are HEX strings because Buffers are not cleanly serialisable over the message bus.
 */
export interface BlePacket {
    /** Id of the subscription that matched this advertisement. */
    subscriptionId: string;
    /** Lowercased MAC address. */
    address: string;
    addressType: string;
    rssi: number;
    /** Date.now() when the gateway received the advertisement. */
    ts: number;
    localName?: string;
    txPowerLevel?: number;
    serviceUuids?: string[];
    /** HEX string of the raw manufacturer data, or undefined if none. */
    manufacturerData?: string;
    /** Service data entries, each `data` field is a HEX string. */
    serviceData?: { uuid: string; data: string }[];
}

/** Payload of a `subscribe` message (subscriber → gateway). */
export interface SubscribePayload {
    /** Unique id per subscriber. Re-using an id replaces the previous subscription. */
    subscriptionId: string;
    filter: BleFilter;
    /** Minimum delay (ms) between two packets for the same address on this subscription. 0 = deliver all. */
    minIntervalMs?: number;
}

/** Payload of an `unsubscribe` message. Omitting subscriptionId removes all of the sender's subscriptions. */
export interface UnsubscribePayload {
    subscriptionId?: string;
}

/** Info about the active HCI controller, returned on subscribe/getStatus. */
export interface ControllerInfo {
    hciId: number;
    powerState: string;
    scanning: boolean;
}

/** A subscription as held by the gateway. */
export interface Subscription {
    /** Subscriber instance id, e.g. "wattcycle.0" (derived from message `from`). */
    subscriberId: string;
    subscriptionId: string;
    filter: BleFilter;
    minIntervalMs: number;
    /** Last delivery timestamp per lowercased address, for throttling. */
    lastSent: Map<string, number>;
}
