// Grab the UI elements
const connectBtn = document.getElementById('connectBtn');
const channelSelect = document.getElementById('channelSelect');
const statusText = document.getElementById('statusText');

// Listen for the connect button click
connectBtn.addEventListener('click', () => {
    // Get the current selected value from the dropdown
    const selectedChannel = channelSelect.value;
    
    // Update the UI to show we are trying to do something
    statusText.innerText = `Status: Searching for ${selectedChannel}...`;
    
    // NOTE: This is where we will inject the Web Bluetooth API 
    // code in the next phase to actually scan for the device.
    console.log(`Initiating Bluetooth scan with parameter: ${selectedChannel}`);
});