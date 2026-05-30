const WebSocket = require('ws');

async function test() {
    try {
        const res = await fetch('http://127.0.0.1:3000/api/status');
        const json = await res.json();
        console.log("REST API STATUS:", json);
    } catch (e) {
        console.error("REST ERR:", e.message);
    }

    const ws = new WebSocket('ws://127.0.0.1:3000/telemetry');
    ws.on('open', () => {
        console.log("WS CONNECTED");
    });
    ws.on('message', (data) => {
        const event = JSON.parse(data);
        if (event.type === 'PREDICTIVE_AGGREGATE' || event.type === 'LEAD_LAG_UPDATE' || event.type === 'FEED_STATUS') {
            console.log("RECEIVED", event.type, JSON.stringify(event.payload));
        }
    });
    ws.on('error', (err) => console.error("WS ERR:", err.message));
    
    setTimeout(() => {
        ws.close();
        process.exit(0);
    }, 3000);
}
test();