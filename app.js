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
    
    // 1. Check for physical controller overrides first!
    pollPhysicalController();

    // 2. Existing logic...
    let currentlyIdle = isControllerIdle();

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

// --- Physical Controller Integration ---
let physicalGamepadIndex = null;
const DEADZONE = 0.1; // Threshold to determine if sticks are being touched

// 1. Connection Event Listeners
window.addEventListener("gamepadconnected", (e) => {
    physicalGamepadIndex = e.gamepad.index;
    const gp = navigator.getGamepads()[physicalGamepadIndex];
    
    // Update UI to HYBRID mode
    document.getElementById('modeText').textContent = "Mode: 0x73 HYBRID";
    
    // Extract VID/PID from the gamepad ID string (Browser dependent format)
    // Fallback to displaying the first 30 chars of the ID string if exact VID/PID isn't parsed
    document.getElementById('hwIdText').textContent = "HW: " + gp.id.substring(0, 30);
    document.getElementById('hwIdText').style.display = "inline";
    
    console.log(`Physical Controller Connected: ${gp.id}`);
});

window.addEventListener("gamepaddisconnected", (e) => {
    if (e.gamepad.index === physicalGamepadIndex) {
        physicalGamepadIndex = null;
        
        // Revert UI to ANALOG mode
        document.getElementById('modeText').textContent = "Mode: 0x73 ANALOG";
        document.getElementById('hwIdText').style.display = "none";
        
        console.log("Physical Controller Disconnected");
    }
});

// 2. Headless Polling Logic (Call this inside your main data loop or requestAnimationFrame)
function pollPhysicalController() {
    if (physicalGamepadIndex === null) return;
    
    const gp = navigator.getGamepads()[physicalGamepadIndex];
    if (!gp) return;

    // --- JOYSTICK PRIORITY & VISUAL MIRRORING ---
    // Left Stick (Standard Axes 0 = X, 1 = Y)
    if (Math.abs(gp.axes[0]) > DEADZONE || Math.abs(gp.axes[1]) > DEADZONE) {
        // Convert from -1.0 to 1.0 float scale to your 0-255 uint8_t scale
        let lx = Math.round(((gp.axes[0] + 1) / 2) * 255);
        let ly = Math.round(((gp.axes[1] + 1) / 2) * 255); // NOTE: Y axis may need inversion depending on your specific array map
        
        // Overwrite the uint8_t array (Assuming standard PS2 indices for LX and LY)
        ps2Data[7] = lx; 
        ps2Data[8] = ly; 
        
        // Visual Mirroring (Update your virtual CSS transform here)
        mirrorVirtualStick('leftStick', gp.axes[0], gp.axes[1]);
    }

    // Right Stick (Standard Axes 2 = X, 3 = Y)
    if (Math.abs(gp.axes[2]) > DEADZONE || Math.abs(gp.axes[3]) > DEADZONE) {
        let rx = Math.round(((gp.axes[2] + 1) / 2) * 255);
        let ry = Math.round(((gp.axes[3] + 1) / 2) * 255);
        
        ps2Data[5] = rx;
        ps2Data[6] = ry;
        
        mirrorVirtualStick('rightStick', gp.axes[2], gp.axes[3]);
    }

    // --- INPUT REDUNDANCY (Buttons) ---
    // Standard Gamepad API Mapping: 0=A/Cross, 1=B/Circle, 2=X/Square, 3=Y/Triangle
    // L3 = 10, R3 = 11. 
    // We clear the bit (set to 0) if pressed, to merge with virtual buttons.
    
    if (gp.buttons[10].pressed) { 
        ps2Data[3] &= ~0x02; // Assuming L3 is Byte 3, Bit 1
        highlightVirtualButton('L3');
    }
    if (gp.buttons[11].pressed) { 
        ps2Data[3] &= ~0x04; // Assuming R3 is Byte 3, Bit 2
        highlightVirtualButton('R3');
    }
    
    if (gp.buttons[0].pressed) ps2Data[4] &= ~0x40; // Cross
    if (gp.buttons[1].pressed) ps2Data[4] &= ~0x20; // Circle
    if (gp.buttons[2].pressed) ps2Data[4] &= ~0x80; // Square
    if (gp.buttons[3].pressed) ps2Data[4] &= ~0x10; // Triangle
    // Add L1, R1, L2, R2 as needed based on your specific bitmask configuration
}

// 3. Helper functions for Visual Mirroring
function mirrorVirtualStick(stickId, axisX, axisY) {
    const stickEl = document.getElementById(stickId);
    if (!stickEl) return;
    
    // Max pixel radius for the UI stick
    const maxRadius = 40; 
    const moveX = axisX * maxRadius;
    const moveY = axisY * maxRadius;
    
    stickEl.style.transform = `translate(${moveX}px, ${moveY}px)`;
}

function highlightVirtualButton(buttonId) {
    const btnEl = document.getElementById(buttonId);
    if (btnEl) {
        btnEl.classList.add('active-press'); // Assumes you have a CSS class for pressed state
        setTimeout(() => btnEl.classList.remove('active-press'), 50);
    }
}

// Example usage to trigger the happy face:
// sendCommandPacket(1, 255, 128);