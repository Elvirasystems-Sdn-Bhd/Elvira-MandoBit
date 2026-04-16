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
const DEADZONE = 0.1; 
let prevGamepadBtns = new Array(20).fill(false); // Tracks button releases to prevent them getting stuck!

// 1. Connection Event Listeners
window.addEventListener("gamepadconnected", (e) => {
    physicalGamepadIndex = e.gamepad.index;
    const gp = navigator.getGamepads()[physicalGamepadIndex];
    document.getElementById('modeText').textContent = "Mode: 0x73 HYBRID";
    document.getElementById('hwIdText').textContent = "HW: " + gp.id.substring(0, 30);
    document.getElementById('hwIdText').style.display = "inline";
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

    // --- JOYSTICK OVERRIDES ---
    // Left Stick
    if (Math.abs(gp.axes[0]) > DEADZONE || Math.abs(gp.axes[1]) > DEADZONE) {
        ps2Data[7] = Math.round(((gp.axes[0] + 1) / 2) * 255);
        ps2Data[8] = Math.round(((gp.axes[1] + 1) / 2) * 255);
        mirrorVirtualStick('leftThumb', gp.axes[0], gp.axes[1]);
        prevGamepadBtns['L_STICK_ACTIVE'] = true;
    } else if (prevGamepadBtns['L_STICK_ACTIVE']) {
        // Snap to center when released
        mirrorVirtualStick('leftThumb', 0, 0); 
        ps2Data[7] = 128;
        ps2Data[8] = 128;
        prevGamepadBtns['L_STICK_ACTIVE'] = false;
    }

    // Right Stick
    if (Math.abs(gp.axes[2]) > DEADZONE || Math.abs(gp.axes[3]) > DEADZONE) {
        ps2Data[5] = Math.round(((gp.axes[2] + 1) / 2) * 255);
        ps2Data[6] = Math.round(((gp.axes[3] + 1) / 2) * 255);
        mirrorVirtualStick('rightThumb', gp.axes[2], gp.axes[3]);
        prevGamepadBtns['R_STICK_ACTIVE'] = true;
    } else if (prevGamepadBtns['R_STICK_ACTIVE']) {
        // Snap to center when released
        mirrorVirtualStick('rightThumb', 0, 0);
        ps2Data[5] = 128;
        ps2Data[6] = 128;
        prevGamepadBtns['R_STICK_ACTIVE'] = false;
    }

    // --- BUTTON MAPPINGS (Matches HUD data-btn EXACTLY) ---
    const mappings = [
        { gpIdx: 12, byte: 3, mask: 0x10, name: 'Up' },
        { gpIdx: 13, byte: 3, mask: 0x40, name: 'Down' },
        { gpIdx: 14, byte: 3, mask: 0x80, name: 'Left' },
        { gpIdx: 15, byte: 3, mask: 0x20, name: 'Right' },
        
        { gpIdx: 0, byte: 4, mask: 0x40, name: 'Cross' },
        { gpIdx: 1, byte: 4, mask: 0x20, name: 'Circle' },
        { gpIdx: 2, byte: 4, mask: 0x80, name: 'Square' },
        { gpIdx: 3, byte: 4, mask: 0x10, name: 'Triangle' },
        
        { gpIdx: 4, byte: 4, mask: 0x04, name: 'L1' },
        { gpIdx: 5, byte: 4, mask: 0x08, name: 'R1' },
        { gpIdx: 6, byte: 4, mask: 0x01, name: 'L2' },
        { gpIdx: 7, byte: 4, mask: 0x02, name: 'R2' },
        
        { gpIdx: 8, byte: 3, mask: 0x01, name: 'Select' },
        { gpIdx: 9, byte: 3, mask: 0x08, name: 'Start' }
    ];

    mappings.forEach(m => {
        // Double check array exists before reading
        const isPressed = gp.buttons[m.gpIdx] && gp.buttons[m.gpIdx].pressed;
        const wasPressed = prevGamepadBtns[m.gpIdx];

        if (isPressed && !wasPressed) {
            // Button JUST pressed down -> Clear the bit (Active LOW)
            ps2Data[m.byte] &= ~m.mask;
            highlightVirtualButton(m.name, true);
            prevGamepadBtns[m.gpIdx] = true;
        } else if (!isPressed && wasPressed) {
            // Button JUST released -> Return bit to 1
            ps2Data[m.byte] |= m.mask;
            highlightVirtualButton(m.name, false);
            prevGamepadBtns[m.gpIdx] = false;
        }
    });
}

// 3. Helper functions for Visual Mirroring
function mirrorVirtualStick(thumbId, axisX, axisY) {
    const thumbEl = document.getElementById(thumbId);
    if (!thumbEl) return;
    
    // Scale movement to the visual HUD limits
    const maxRadius = 40; 
    const moveX = axisX * maxRadius;
    const moveY = axisY * maxRadius;
    
    // Using calc(-50% + X) prevents the thumb stick from glitching off-center!
    thumbEl.style.transform = `translate(calc(-50% + ${moveX}px), calc(-50% + ${moveY}px))`;
    
    // Flash the border to show it is active
    if(axisX !== 0 || axisY !== 0) thumbEl.classList.add('active');
    else thumbEl.classList.remove('active');
}

function highlightVirtualButton(buttonName, isPressed) {
    // Queries exact data-btn matching your builder's HTML
    const btnEl = document.querySelector(`[data-btn="${buttonName}"]`);
    if (btnEl) {
        if (isPressed) btnEl.classList.add('pressed'); 
        else btnEl.classList.remove('pressed');
    }
}

// Example usage to trigger the happy face:
// sendCommandPacket(1, 255, 128);