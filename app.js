// ==========================================
// 1. IMMERSIVE GAMING MODE (MANUAL TOGGLE)
// ==========================================
let wakeLock = null;
const fullscreenBtn = document.getElementById('fullscreenBtn');

async function toggleImmersiveMode() {
    try {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen().catch(e => console.warn(e));
            if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape').catch(e => console.warn(e));
            if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen').catch(e => console.warn(e));
            
            if(fullscreenBtn) {
                fullscreenBtn.innerText = "EXIT FULLSCREEN";
                fullscreenBtn.style.color = "#ff3d71";
                fullscreenBtn.style.borderColor = "#ff3d71";
            }
        } else {
            if (document.exitFullscreen) await document.exitFullscreen();
            if (wakeLock !== null) { wakeLock.release(); wakeLock = null; }
            
            if(fullscreenBtn) {
                fullscreenBtn.innerText = "FULLSCREEN";
                fullscreenBtn.style.color = "#00e5ff";
                fullscreenBtn.style.borderColor = "#00e5ff";
            }
        }
    } catch (err) { console.warn("Immersive API error:", err); }
}

if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleImmersiveMode);

document.addEventListener('visibilitychange', async () => {
    if (document.fullscreenElement && wakeLock !== null && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen').catch(e=>{});
    }
});

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(e => {});
    });
}

// ==========================================
// 2. BLUETOOTH & CONNECTION LOGIC
// ==========================================
// Grab the UI elements
const connectBtn = document.getElementById('connectBtn');
const channelSelect = document.getElementById('channelSelect');
const statusText = document.getElementById('statusText');
const connectOverlay = document.getElementById('connectOverlay'); // Added to hide the menu later

// Micro:Bit UART Service UUIDs
const UART_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const UART_TX_CHARACTERISTIC_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // Micro:bit -> Laptop (Listen)
const UART_RX_CHARACTERISTIC_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // Laptop -> Micro:bit (Write)

let bluetoothDevice;
let server;
let writeChar; // <--- CRITICAL: Defines the transmitter variable!
let heartbeatInterval = null;
let handshakeWatchdog = null;
let lastPayloadStr = "";
let bleSleepTimer = null;

// Listen for the connect button click
connectBtn.addEventListener('click', async () => {
    try {
        statusText.innerText = "Status: Scanning for Micro:Bit...";
        
        // 1. Request the Bluetooth device
        bluetoothDevice = await navigator.bluetooth.requestDevice({
            filters: [{ namePrefix: 'BBC micro:bit' }],
            optionalServices: [UART_SERVICE_UUID]
        });

        statusText.innerText = "Status: Connecting to " + bluetoothDevice.name + "...";

        // 2. Connect to the GATT server
        server = await bluetoothDevice.gatt.connect();

        // 3. Get the UART Service
        const service = await server.getPrimaryService(UART_SERVICE_UUID);

        // 4. Get BOTH Data Pipelines
        const rxCharacteristic = await service.getCharacteristic(UART_TX_CHARACTERISTIC_UUID); // Listener
        writeChar = await service.getCharacteristic(UART_RX_CHARACTERISTIC_UUID);              // Transmitter

        // 5. Start listening for the handshake string
        await rxCharacteristic.startNotifications();
        rxCharacteristic.addEventListener('characteristicvaluechanged', handleHandshake);

        // 6. Inject the bouncing emoji CSS
        if (!document.getElementById('handshakeStyle')) {
            const style = document.createElement('style');
            style.id = 'handshakeStyle';
            style.innerHTML = `@keyframes handshake-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } } .handshake-anim { display: inline-block; animation: handshake-bounce 0.6s ease-in-out infinite; }`;
            document.head.appendChild(style);
        }

        // Show the animated status
        statusText.innerHTML = `Status: Connected! Waiting for handshake <span class="handshake-anim">🤝</span>`;

        // 7. Start the PING watchdog (Sends "PING\n" every 500ms)
        if (handshakeWatchdog) clearInterval(handshakeWatchdog);
        handshakeWatchdog = setInterval(() => {
            if (writeChar) {
                let encoder = new TextEncoder();
                writeChar.writeValueWithoutResponse(encoder.encode("PING\n")).catch(()=>{});
            }
        }, 500);

    } catch (error) {
        console.error(error);
        statusText.innerText = "Status: Connection Failed or Cancelled.";
    }
});

// Function to handle incoming handshake and START the data stream
function handleHandshake(event) {
    let message = new TextDecoder('utf-8').decode(event.target.value).trim();
    console.log("Received: " + message);
    
    if (message.includes("HANDSHAKE")) {
        let hwChannel = message.split(":")[1];
        
        if (hwChannel === channelSelect.value || channelSelect.value === "DEBUG") {
            // >>> ADD THIS LINE TO STOP PINGING <<<
            if (handshakeWatchdog) clearInterval(handshakeWatchdog);
            // Hide overlay
            if (connectOverlay) connectOverlay.style.display = 'none'; // Success! Reveal the HUD!
            // Reveal the Settings & Fullscreen buttons
            const gameControls = document.getElementById('gameControls');
            if (gameControls) gameControls.style.display = 'flex';
            // --- START THE HEARTBEAT AT 50ms ---
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(sendControllerData, 50); 
            
        } else {
            statusText.innerText = `Error: App expected Ch ${channelSelect.value}, got Ch ${hwChannel}`;
        }
    }
}

// ==========================================
// BLE TRANSMITTER FUNCTION (Runs every 50ms)
// ==========================================
function sendControllerData() {
    if (typeof writeChar !== 'undefined' && writeChar) {
        
        const currentPayloadStr = ps2Data.slice(1).join(',');
        const bleStatusText = document.getElementById('bleStatusText'); 
        
        // Define the exact "Idle" state of the controller
        const isIdle = (
            ps2Data[3] === 0xFF && 
            ps2Data[4] === 0xFF && 
            ps2Data[5] === 0x80 && 
            ps2Data[6] === 0x80 && 
            ps2Data[7] === 0x80 && 
            ps2Data[8] === 0x80
        );

        // Trigger ONLY if data changed, OR if we are actively holding a button/stick
        if (currentPayloadStr !== lastPayloadStr || !isIdle) {
            
            // 1. Keep the Watchdog fed!
            ps2Data[0]++;
            if (ps2Data[0] === 0x00) ps2Data[0] = 0x01; 
            
            lastPayloadStr = currentPayloadStr;
            
            // 2. Format and Send over BLE
            let hexString = Array.from(ps2Data).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
            hexString += '\n';
            let encoder = new TextEncoder();
            
            writeChar.writeValueWithoutResponse(encoder.encode(hexString))
                .catch(err => {
                    if (err.name !== 'NetworkError') console.warn("BLE Write Error:", err);
                });
            
            // 3. Update HUD to Transmitting
            if (bleStatusText) {
                bleStatusText.innerText = "*Transmitting";
                bleStatusText.style.color = "#00e5ff"; 
            }
            
            // 4. Reset the Sleep Timer
            clearTimeout(bleSleepTimer);
            bleSleepTimer = setTimeout(() => {
                if (bleStatusText) {
                    bleStatusText.innerText = "*BLE sleeping";
                    bleStatusText.style.color = "#ff3d71"; 
                }
            }, 150);
        }
    }
}

// ==========================================
// 3. GLOBAL VARIABLES & GAMEPAD LOGIC
// ==========================================
// IT MUST BE A Uint8Array, NOT JUST []
let ps2Data = new Uint8Array([0xFF, 0x73, 0x5A, 0xFF, 0xFF, 0x80, 0x80, 0x80, 0x80]);

// NEW: Variables to give touchscreen priority
let isLeftDragging = false;
let isRightDragging = false;

// FIXED: Brought back missing Gamepad variables
const DEADZONE = 0.15; 
let prevGamepadBtns = {};

function pollGamepad() {
    try {
        const gamepads = navigator.getGamepads();
        const gp = gamepads[0];
        
        if (gp) {
            const modeText = document.getElementById('modeText');
            if (modeText && !modeText.textContent.includes("HYBRID")) {
                modeText.textContent = "Mode: 0x73 HYBRID (XBOX)";
                modeText.style.color = "#00ff7f"; 
            }

            if (typeof ps2Data === 'undefined') return; 

            // --- JOYSTICK LOGIC (Physical to Virtual) ---
            if (!isLeftDragging) {
                let lx = Math.abs(gp.axes[0]) > DEADZONE ? gp.axes[0] : 0;
                let ly = Math.abs(gp.axes[1]) > DEADZONE ? gp.axes[1] : 0;
                ps2Data[7] = Math.round(((lx + 1) / 2) * 255); 
                ps2Data[8] = Math.round(((ly + 1) / 2) * 255);
            }

            if (!isRightDragging) {
                let rx = Math.abs(gp.axes[2]) > DEADZONE ? gp.axes[2] : 0;
                let ry = Math.abs(gp.axes[3]) > DEADZONE ? gp.axes[3] : 0;
                ps2Data[5] = Math.round(((rx + 1) / 2) * 255);
                ps2Data[6] = Math.round(((ry + 1) / 2) * 255);
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
                { gpIdx: 9, byte: 3, mask: 0x08, name: 'START' },
                { gpIdx: 10, byte: 3, mask: 0x02, name: 'L3' },
                { gpIdx: 11, byte: 3, mask: 0x04, name: 'R3' }
            ];

            mappings.forEach(m => {
                const rawBtn = gp.buttons[m.gpIdx];
                if (rawBtn === undefined) return; 

                const isPressed = typeof rawBtn === "object" ? rawBtn.pressed : rawBtn > 0;
                const wasPressed = prevGamepadBtns[m.gpIdx];

                if (isPressed && !wasPressed) {
                    ps2Data[m.byte] &= ~m.mask; 
                    safeHighlightBtn(m.name, true);
                    prevGamepadBtns[m.gpIdx] = true;
                    if (gp.vibrationActuator) gp.vibrationActuator.playEffect("dual-rumble", { startDelay: 0, duration: 100, weakMagnitude: 0.5, strongMagnitude: 0.5 }).catch(() => {});
                } else if (!isPressed && wasPressed) {
                    ps2Data[m.byte] |= m.mask;
                    safeHighlightBtn(m.name, false);
                    prevGamepadBtns[m.gpIdx] = false;
                }
            });

        } // <--- THIS BRACKET CLOSES THE "if (gp)" BLOCK

        // >>> CRITICAL FIX: Now it is safely OUTSIDE! <<<
        // This will run 60 times a second, even if no gamepad is connected.
        updateHexDisplay(); 

    } catch (error) {
        console.warn("Gamepad poll error", error);
    }
    requestAnimationFrame(pollGamepad); 
}

// ==========================================
// 4. SETTINGS MENU & EDIT LAYOUT LOGIC
// ==========================================
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsMenu = document.getElementById('settingsMenu');
const editLayoutBtn = document.getElementById('editLayoutBtn');

if (settingsToggleBtn) {
    settingsToggleBtn.addEventListener('click', () => {
        settingsMenu.classList.toggle('active');
    });
}

if (editLayoutBtn) {
    editLayoutBtn.addEventListener('click', () => {
        document.body.classList.toggle('edit-mode');
        if (document.body.classList.contains('edit-mode')) {
            editLayoutBtn.style.background = "rgba(0, 229, 255, 0.3)";
            editLayoutBtn.innerText = "FINISH EDITING";
        } else {
            editLayoutBtn.style.background = "transparent";
            editLayoutBtn.innerText = "EDIT LAYOUT";
            settingsMenu.classList.remove('active');
        }
    });
}

// ==========================================
// 5. TOUCH EVENTS & HEX RAW DATA MAPPING
// ==========================================

// FIXED: Names now match your HTML tags and Gamepad bindings perfectly
const PS2_MASKS = {
    'SELECT': { byte: 3, mask: 0x01 }, 'L3': { byte: 3, mask: 0x02 }, 'R3': { byte: 3, mask: 0x04 }, 'START': { byte: 3, mask: 0x08 },
    'UP': { byte: 3, mask: 0x10 }, 'RIGHT': { byte: 3, mask: 0x20 }, 'DOWN': { byte: 3, mask: 0x40 }, 'LEFT': { byte: 3, mask: 0x80 },
    'L2': { byte: 4, mask: 0x01 }, 'R2': { byte: 4, mask: 0x02 }, 'L1': { byte: 4, mask: 0x04 }, 'R1': { byte: 4, mask: 0x08 },
    'TRI': { byte: 4, mask: 0x10 }, 'CRC': { byte: 4, mask: 0x20 }, 'CRS': { byte: 4, mask: 0x40 }, 'SQ': { byte: 4, mask: 0x80 }
};

// --- NEW VARIABLES FOR BLE SLEEP & HEADER LOGIC ---
// let lastPayloadStr = "";
// let bleSleepTimer = null;

function updateHexDisplay() {
    // 1. Update the main RAW DATA display at the bottom
    for (let i = 0; i < 9; i++) {
        const el = document.getElementById('byte' + i);
        if (el) {
            const newHex = '0x' + ps2Data[i].toString(16).toUpperCase().padStart(2, '0');
            if (el.innerText !== newHex) {
                el.innerText = newHex;
                el.classList.add('changed');
                setTimeout(() => el.classList.remove('changed'), 150);
            }
        }
    }

    // 2. Update the X and Y text values under the Joysticks
    const leftStickVal = document.getElementById('leftStickVal');
    const rightStickVal = document.getElementById('rightStickVal');
    
    if (leftStickVal) leftStickVal.innerText = `X:${ps2Data[7].toString(16).toUpperCase().padStart(2, '0')} Y:${ps2Data[8].toString(16).toUpperCase().padStart(2, '0')}`;
    if (rightStickVal) rightStickVal.innerText = `X:${ps2Data[5].toString(16).toUpperCase().padStart(2, '0')} Y:${ps2Data[6].toString(16).toUpperCase().padStart(2, '0')}`;

    // 3. Update the visual joysticks on the screen
    safeMirrorStick('leftThumb', (ps2Data[7] / 255) * 2 - 1, (ps2Data[8] / 255) * 2 - 1);
    safeMirrorStick('rightThumb', (ps2Data[5] / 255) * 2 - 1, (ps2Data[6] / 255) * 2 - 1);
}
updateHexDisplay(); 

const allButtons = document.querySelectorAll('.btn-action, .dpad-btn, .shoulder-btn, .meta-btn, .stick-label-btn');

allButtons.forEach(btn => {
    btn.addEventListener('touchstart', (e) => {
        e.preventDefault(); 
        btn.classList.add('active'); 
        
        // Convert the HTML tag to UPPERCASE just in case
        const btnName = btn.getAttribute('data-btn').toUpperCase();
        const maskInfo = PS2_MASKS[btnName];
        if (maskInfo) {
            ps2Data[maskInfo.byte] &= ~maskInfo.mask; 
            updateHexDisplay();
        }
    }, { passive: false });

    btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        btn.classList.remove('active'); 
        
        const btnName = btn.getAttribute('data-btn').toUpperCase();
        const maskInfo = PS2_MASKS[btnName];
        if (maskInfo) {
            ps2Data[maskInfo.byte] |= maskInfo.mask; 
            updateHexDisplay();
        }
    }, { passive: false });
});

function setupJoystick(zoneId, thumbId) {
    const zone = document.getElementById(zoneId);
    if (!zone) return;

    const maxRadius = zone.getBoundingClientRect().width / 2;

    zone.addEventListener('touchstart', (e) => { 
        e.preventDefault(); 
        if (zoneId === 'leftStickZone') isLeftDragging = true;
        if (zoneId === 'rightStickZone') isRightDragging = true;
        updateStick(e); 
    }, { passive: false });

    zone.addEventListener('touchmove', (e) => { 
        e.preventDefault(); 
        updateStick(e); 
    }, { passive: false });

    zone.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (zoneId === 'leftStickZone') { 
            isLeftDragging = false; 
            ps2Data[7] = 128; 
            ps2Data[8] = 128; 
        }
        if (zoneId === 'rightStickZone') { 
            isRightDragging = false; 
            ps2Data[5] = 128; 
            ps2Data[6] = 128; 
        }
        updateHexDisplay(); // This snaps it back to center instantly
    }, { passive: false });

    function updateStick(e) {
        // Stop calculating if this specific joystick isn't being touched
        if (zoneId === 'leftStickZone' && !isLeftDragging) return;
        if (zoneId === 'rightStickZone' && !isRightDragging) return;

        const touch = e.targetTouches[0];
        const rect = zone.getBoundingClientRect();
        const centerX = rect.left + maxRadius;
        const centerY = rect.top + maxRadius;
        
        let dx = touch.clientX - centerX;
        let dy = touch.clientY - centerY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > maxRadius) {
            dx = (dx / distance) * maxRadius;
            dy = (dy / distance) * maxRadius;
        }
        
        let hexValX = Math.round(((dx + maxRadius) / (maxRadius * 2)) * 255);
        let hexValY = Math.round(((dy + maxRadius) / (maxRadius * 2)) * 255);

        if (zoneId === 'leftStickZone') { ps2Data[7] = hexValX; ps2Data[8] = hexValY; }
        if (zoneId === 'rightStickZone') { ps2Data[5] = hexValX; ps2Data[6] = hexValY; }
        
        updateHexDisplay(); // Updates the array AND visually moves the stick!
    }
}

setupJoystick('leftStickZone', 'leftThumb');
setupJoystick('rightStickZone', 'rightThumb');

requestAnimationFrame(pollGamepad);

// Safe Visual Helpers
function safeMirrorStick(thumbId, axisX, axisY) {
    const thumb = document.getElementById(thumbId);
    if (!thumb) return;
    
    const maxRadius = 40; 
    thumb.style.transform = `translate(calc(-50% + ${axisX * maxRadius}px), calc(-50% + ${axisY * maxRadius}px))`;
    
    // Check if there is a parent element to apply the glow to
    const zone = thumb.parentElement;
    if (zone && zone.classList) {
        // We use 0.05 to ignore tiny floating point math errors
        if (Math.abs(axisX) > 0.05 || Math.abs(axisY) > 0.05) {
            zone.classList.add('active');
        } else {
            zone.classList.remove('active');
        }
    }
}

function safeHighlightBtn(buttonName, isPressed) {
    // Notice the " i]" at the end of the query. This ignores uppercase/lowercase differences!
    const btnEl = document.querySelector(`[data-btn="${buttonName}" i]`);
    
    if (!btnEl) return; 
    
    if (isPressed) {
        btnEl.classList.add('active'); 
    } else {
        btnEl.classList.remove('active');
    }
}