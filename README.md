<img src="admin/ble-gateway.png" width="100" />

# ioBroker.ble-gateway

A central BLE gateway for ioBroker. Exactly **one** controller can be owned per process, so this adapter owns the Bluetooth (HCI) controller, scans passively, and **shares BLE advertisement packets** with any number of other adapters over the ioBroker message bus.

Other adapters subscribe with a packet filter (MAC, service UUID, name prefix, manufacturer id), receive matching advertisements as `blePacket` messages, and unsubscribe on stop. **No controller is opened until the first adapter subscribes.**

## How it works

```
  some-adapter.0 ──subscribe{macs:[…]}──▶ ┌───────────────┐
  other-adapter.0 ─subscribe{uuid:[…]}──▶ │ ble-gateway.0 │──noble──▶ HCI controller
                                           │ owns the BLE  │   (passive scan)
  some-adapter.0  ◀──── 'blePacket' ────── │   controller  │
  other-adapter.0 ◀──── 'blePacket' ────── └───────────────┘
```

- First subscription → controller is opened and continuous scanning starts.
- Last subscription gone → scanning stops (controller goes idle).
- If a subscriber dies without unsubscribing, the gateway notices via its
  `system.adapter.<id>.alive` state and drops its subscriptions automatically.

> **Phase 1** delivers passive advertisement packets only. An active GATT proxy
> (connect/read/write/notify) is planned as a later, additive extension.

## Configuration

On the **Main settings** tab choose the **Bluetooth adapter** by MAC address
(BD_ADDR — stable across reboots, unlike the `hciX` numbering). The
**Diagnostics** tab offers a one-shot scan to verify the controller and a status
button showing active subscriptions.

## Message protocol (for adapter authors)

Send these from your adapter with `this.sendTo('ble-gateway.0', command, payload, cb)`.

### `subscribe`
```js
sendTo('ble-gateway.0', 'subscribe', {
    subscriptionId: 'sensors',          // unique per subscriber; re-using replaces
    filter: {
        macs: ['aa:bb:cc:dd:ee:ff'],    // lowercased MACs (most common)
        serviceUuids: ['fff0'],         // any of these (short or long form)
        namePrefixes: ['Govee'],        // localName startsWith (case-insensitive)
        manufacturerId: 0x004c          // company id (first 2 bytes of mfg data, LE)
    },
    minIntervalMs: 0                    // optional throttle per address; 0 = all
}, res => console.log(res));           // { ok: true, controller: {…} }
```
All filter criteria are AND-combined; within a list the match is OR. An empty
filter matches **every** device (a warning is logged).

### `unsubscribe`
```js
sendTo('ble-gateway.0', 'unsubscribe', { subscriptionId: 'sensors' }); // one
sendTo('ble-gateway.0', 'unsubscribe', {});                            // all of mine
```

### `getStatus`
```js
sendTo('ble-gateway.0', 'getStatus', null, res => console.log(res));
// { controller: {hciId, powerState, scanning}, subscribers, subscriptions: [...] }
```

### Receiving packets — `blePacket` (gateway → your adapter)
Implement a `message` handler in your adapter. Binary fields arrive as **HEX strings**:
```js
{
    subscriptionId: 'sensors',
    address: 'aa:bb:cc:dd:ee:ff',
    addressType: 'public',
    rssi: -67,
    ts: 1717000000000,
    localName: 'Govee_1234',
    txPowerLevel: -59,
    serviceUuids: ['fff0'],
    manufacturerData: '4c000215...',          // HEX
    serviceData: [{ uuid: 'fff0', data: '...' }] // data = HEX
}
```

## Client helper

`src/lib/ble-gateway-client.ts` is a small, dependency-free helper you can **copy
into your own adapter**. It handles subscribe/unsubscribe, converts HEX back to
`Buffer`, and automatically re-subscribes if the gateway restarts (it watches
`ble-gateway.0.info.connection`).

```ts
import { BleGatewayClient } from './lib/ble-gateway-client';

class MyAdapter extends Adapter {
    private ble = new BleGatewayClient(this);

    constructor(options) {
        super({ ...options,
            message:     obj         => { if (!this.ble.handleMessage(obj)) { /* your commands */ } },
            stateChange: (id, state) => this.ble.handleStateChange(id, state),
            unload:      cb          => this.ble.destroy().finally(cb),
            ready:       ()          => this.onReady(),
        });
    }

    async onReady() {
        await this.ble.subscribe('sensors', { macs: ['aa:bb:cc:dd:ee:ff'] }, packet => {
            this.log.info(`${packet.address} rssi=${packet.rssi} ${packet.manufacturerData?.toString('hex')}`);
        });
    }
}
```

## States

| State                | Type    | Description                              |
|----------------------|---------|------------------------------------------|
| `info.connection`    | boolean | Controller open and scanning             |
| `info.subscribers`   | number  | Number of subscribed adapters            |
| `info.subscriptions` | string  | JSON list of active subscriptions        |

## Requirements

- Linux with BlueZ (`apt install bluez libbluetooth-dev`) or macOS.
- Node.js ≥ 20.
- The adapter must be allowed to access the HCI socket (typically run as root or with `setcap`).

## Changelog
<!--
   Placeholder for the next version (at the beginning of the line):
   ### **WORK IN PROGRESS**
-->
### **WORK IN PROGRESS**
* (@GermanBluefox) Initial version — passive advertisement gateway with message-based subscribe/unsubscribe.

## License

MIT License

Copyright (c) 2026 bluefox <dogafox@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
