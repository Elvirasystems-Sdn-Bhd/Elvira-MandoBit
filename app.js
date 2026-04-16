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

// ==========================================
// BULLETPROOF GAMEPAD INTEGRATION
// ==========================================
// We wrap this in a 'load' event so it strictly waits for your HTML to finish building!
window.addEventListener('load', () => {
    let prevGamepadBtns = new Array(20).fill(false);
    const DEADZONE = 0.15; // Increased slightly to prevent stick drift

    function startGamepadLoop() {
        function pollGamepad() {
            try {
                // 1. Force the browser to grab the latest hardware state
                const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
                let gp = null;

                for (let i = 0; i < gamepads.length; i++) {
                    if (gamepads[i] && gamepads[i].connected) {
                        gp = gamepads[i];
                        break;
                    }
                }

                if (gp) {
                    // Update HUD to show connection
                    const modeText = document.getElementById('modeText');
                    if (modeText && !modeText.textContent.includes("HYBRID")) {
                        modeText.textContent = "Mode: 0x73 HYBRID (XBOX)";
                        modeText.style.color = "#00ff7f"; // Make it turn green!
                    }

                    // CRITICAL SAFEGUARD: Prevent crash if ps2Data isn't loaded
                    if (typeof ps2Data === 'undefined') {
                        if (modeText) modeText.textContent = "ERROR: ps2Data missing!";
                        requestAnimationFrame(pollGamepad);
                        return; 
                    }

                    // --- JOYSTICK LOGIC ---
                    if (Math.abs(gp.axes[0]) > DEADZONE || Math.abs(gp.axes[1]) > DEADZONE) {
                        ps2Data[7] = Math.round(((gp.axes[0] + 1) / 2) * 255);
                        ps2Data[8] = Math.round(((gp.axes[1] + 1) / 2) * 255);
                        safeMirrorStick('LEFT', gp.axes[0], gp.axes[1]);
                        prevGamepadBtns['L_STICK'] = true;
                    } else if (prevGamepadBtns['L_STICK']) {
                        ps2Data[7] = 128; ps2Data[8] = 128;
                        safeMirrorStick('LEFT', 0, 0);
                        prevGamepadBtns['L_STICK'] = false;
                    }

                    if (Math.abs(gp.axes[2]) > DEADZONE || Math.abs(gp.axes[3]) > DEADZONE) {
                        ps2Data[5] = Math.round(((gp.axes[2] + 1) / 2) * 255);
                        ps2Data[6] = Math.round(((gp.axes[3] + 1) / 2) * 255);
                        safeMirrorStick('RIGHT', gp.axes[2], gp.axes[3]);
                        prevGamepadBtns['R_STICK'] = true;
                    } else if (prevGamepadBtns['R_STICK']) {
                        ps2Data[5] = 128; ps2Data[6] = 128;
                        safeMirrorStick('RIGHT', 0, 0);
                        prevGamepadBtns['R_STICK'] = false;
                    }

                    // --- BUTTON LOGIC ---
                    const mappings = [
                        { gpIdx: 12, byte: 3, mask: 0x10, name: 'UP' },
                        { gpIdx: 13, byte: 3, mask: 0x40, name: 'DOWN' },
                        { gpIdx: 14, byte: 3, mask: 0x80, name: 'LEFT' },
                        { gpIdx: 15, byte: 3, mask: 0x20, name: 'RIGHT' },
                        
                        { gpIdx: 0, byte: 4, mask: 0x40, name: 'CRS' },   
                        { gpIdx: 1, byte: 4, mask: 0x20, name: 'CRC' },   
                        { gpIdx: 2, byte: 4, mask: 0x80, name: 'SQ' },    
                        { gpIdx: 3, byte: 4, mask: 0x10, name: 'TRI' },   
                        
                        { gpIdx: 4, byte: 4, mask: 0x04, name: 'L1' },    
                        { gpIdx: 5, byte: 4, mask: 0x08, name: 'R1' },    
                        { gpIdx: 6, byte: 4, mask: 0x01, name: 'L2' },    
                        { gpIdx: 7, byte: 4, mask: 0x02, name: 'R2' },    
                        
                        { gpIdx: 8, byte: 3, mask: 0x01, name: 'SELECT' },
                        { gpIdx: 9, byte: 3, mask: 0x08, name: 'START' }  
                    ];

                    mappings.forEach(m => {
                        const rawBtn = gp.buttons[m.gpIdx];
                        if (rawBtn === undefined) return; // Prevent crashes on missing buttons

                        const isPressed = typeof rawBtn === "object" ? rawBtn.pressed : rawBtn > 0;
                        const wasPressed = prevGamepadBtns[m.gpIdx];

                        if (isPressed && !wasPressed) {
                            ps2Data[m.byte] &= ~m.mask; 
                            safeHighlightBtn(m.name, true);
                            prevGamepadBtns[m.gpIdx] = true;
                            
                            // Haptic Feedback
                            if (gp.vibrationActuator) {
                                gp.vibrationActuator.playEffect("dual-rumble", {
                                    startDelay: 0, duration: 100, weakMagnitude: 0.5, strongMagnitude: 0.5
                                }).catch(() => {});
                            }
                        } else if (!isPressed && wasPressed) {
                            ps2Data[m.byte] |= m.mask;
                            safeHighlightBtn(m.name, false);
                            prevGamepadBtns[m.gpIdx] = false;
                        }
                    });
                }
            } catch (error) {
                // If ANYTHING crashes, print the error to the HUD so we can see it!
                const modeText = document.getElementById('modeText');
                if (modeText) modeText.textContent = "ERR: " + error.message.substring(0, 20);
            }

            requestAnimationFrame(pollGamepad); 
        }
        
        requestAnimationFrame(pollGamepad);
    }

    // Safe Visual Helpers (Will NOT crash if HTML is missing)
    function safeMirrorStick(analogName, axisX, axisY) {
        const track = document.querySelector(`.analog-base[data-analog="${analogName}"]`);
        if (!track) return; 
        const knob = track.querySelector('.analog-stick');
        if (!knob) return;

        const maxRadius = track.getBoundingClientRect().width / 2;
        knob.style.transform = `translate(${axisX * maxRadius}px, ${axisY * maxRadius}px)`;
        if(axisX !== 0 || axisY !== 0) track.classList.add('active');
        else track.classList.remove('active');
    }

    function safeHighlightBtn(buttonName, isPressed) {
        const btnEl = document.querySelector(`[data-btn="${buttonName}"]`);
        if (!btnEl) return; 
        if (isPressed) btnEl.classList.add('active'); 
        else btnEl.classList.remove('active');
    }

    // Start everything up!
    startGamepadLoop();
});
// Example usage to trigger the happy face:
// sendCommandPacket(1, 255, 128);