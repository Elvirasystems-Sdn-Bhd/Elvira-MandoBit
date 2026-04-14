// Grab the UI elements
const connectBtn = document.getElementById('connectBtn');
const channelSelect = document.getElementById('channelSelect');
const statusText = document.getElementById('statusText');

// Micro:Bit UART Service UUIDs
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Micro:bit sends to Laptop

let bluetoothDevice;
let server;

// Listen for the connect button click
connectBtn.addEventListener('click', async () => {
    try {
        statusText.innerText = "Status: Scanning for Micro:Bit...";
        
        // 1. Request the Bluetooth device
        // We filter by name prefix to only show Micro:Bits in the popup
        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'BBC micro:bit' }],
            optionalServices: [UART_SERVICE_UUID]
        });

        statusText.innerText = "Status: Connecting to " + bluetoothDevice.name + "...";

        // 2. Connect to the GATT server
        server = await bluetoothDevice.gatt.connect();

        // 3. Get the UART Service
        const service = await server.getPrimaryService(UART_SERVICE_UUID);

        // 4. Get the TX Characteristic (to receive messages from Micro:Bit)
        const rxCharacteristic = await service.getCharacteristic(UART_TX_CHARACTERISTIC_UUID);

        // 5. Start listening for the handshake string
        await rxCharacteristic.startNotifications();
        rxCharacteristic.addEventListener('characteristicvaluechanged', handleMicrobitMessage);

        statusText.innerText = "Status: Connected! Waiting for handshake...";

    } catch (error) {
        console.error(error);
        statusText.innerText = "Status: Connection Failed or Cancelled.";
    }
});

// Function to handle incoming messages from the Micro:Bit
function handleMicrobitMessage(event) {
    // Convert the raw Bluetooth data into text
    let decoder = new TextDecoder('utf-8');
    let message = decoder.decode(event.target.value);
    
    console.log("Received: " + message);
    
    // If it's our handshake, update the UI!
    if (message.includes("HANDSHAKE")) {
        // Extract the channel number from "HANDSHAKE:1"
        let channel = message.split(":")[1];
        statusText.innerText = `Status: Connected successfully to Channel ${channel}!`;
    }
}

// Function to send a command packet as a compact string
async function sendCommandPacket(cmd, left, right) {
    if (!rxCharacteristic) return; // Make sure we are connected

    // Format the data tightly and MUST include the \n (newline) at the end!
    let payloadString = `${cmd},${left},${right}\n`;
    
    // Web Bluetooth requires data to be sent as a byte array, 
    // so we encode our string into UTF-8 bytes right before sending.
    let encoder = new TextEncoder('utf-8');
    let payload = encoder.encode(payloadString);

    try {
        // Send the payload instantly
        await rxCharacteristic.writeValueWithoutResponse(payload);
        // console.log("Sent: " + payloadString); 
    } catch (error) {
        console.error("Failed to send payload:", error);
    }
}

// Example usage to trigger the happy face:
// sendCommandPacket(1, 255, 128);