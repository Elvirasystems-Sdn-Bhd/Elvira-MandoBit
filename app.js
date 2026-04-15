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

let heartbeatInterval = null;
let sequenceCounter = 0; // The rolling counter

// The function that physically sends the data AND updates the screen
function sendControllerData() {
    if (!writeChar) return;
    
    // 1. Inject the rolling counter into Byte 0, then increment it (0 to 255)
    ps2Data[0] = sequenceCounter;
    sequenceCounter = (sequenceCounter + 1) % 256; 
    
    // 2. FORCE THE HUD TO UPDATE VISUALLY!
    // This makes the HDR bit spin wildly on your screen so you know it's working
    if (typeof updateHexDisplay === 'function') {
        updateHexDisplay(); 
    }

    // 3. Convert the array to hex and send it
    let hexString = Array.from(ps2Data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('') + '\n';
    let payload = new TextEncoder().encode(hexString);
    writeChar.writeValueWithoutResponse(payload).catch(e => console.log("Packet dropped, retrying..."));
}

// Hook into the HUD's visual hex updater 
// (We only update the visual hex here now, the heartbeat handles the Bluetooth)
const originalUpdateHexDisplay = updateHexDisplay;
updateHexDisplay = function() {
    originalUpdateHexDisplay(); 
};

function handleHandshake(event) {
    let message = new TextDecoder('utf-8').decode(event.target.value).trim();
    if (message.includes("HANDSHAKE")) {
        let hwChannel = message.split(":")[1];
        if (hwChannel === channelSelect.value) {
            connectOverlay.style.display = 'none'; // Success! Reveal the HUD!
            checkConnection(); 
            
            // --- START THE HEARTBEAT AT 50ms ---
            // 50ms is the "Goldilocks Zone". It's fast enough for zero-latency 
            // robot control, but slow enough that the Micro:bit buffer never overflows!
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(sendControllerData, 50); 
            
        } else {
            statusText.innerText = `Error: App expected Ch ${channelSelect.value}, got Ch ${hwChannel}`;
        }
    }
}

// Example usage to trigger the happy face:
// sendCommandPacket(1, 255, 128);