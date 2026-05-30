import { useEffect, useRef } from 'react';
import { useStore } from '../store';
import type { TelemetryEvent } from '../types/telemetry';

const WEBSOCKET_URL = "ws://127.0.0.1:3000/telemetry";
const REST_STATUS_URL = "http://127.0.0.1:3000/api/operator/status";
const STATUS_POLL_INTERVAL_MS = 2000;

export function useTelemetry() {
    const { processEvent, setConnected, setOperatorStatus, isConnected, clearAllTelemetry } = useStore();
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lastSessionState = useRef<string | null>(null);
    const lastEngineMode = useRef<string | null>(null);

    useEffect(() => {
        let isMounted = true;

        const fetchStatus = async () => {
            try {
                const res = await fetch(REST_STATUS_URL);
                if (res.ok) {
                    const status = await res.json();
                    if (isMounted) {
                        // Detect transition to idle and clear telemetry
                        if (
                            lastSessionState.current &&
                            lastSessionState.current !== 'idle' &&
                            status.sessionState === 'idle' &&
                            lastEngineMode.current !== 'replay'
                        ) {
                            console.log("[Telemetry] Session ended, clearing telemetry state.");
                            clearAllTelemetry();
                        }
                        lastSessionState.current = status.sessionState;
                        lastEngineMode.current = status.engineMode;
                        setOperatorStatus(status);
                    }
                }
            } catch (err) {
                console.error("Failed to fetch operator status:", err);
            }
        };

        const connect = () => {
            if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
                return;
            }

            console.log(`[Telemetry] Connecting to ${WEBSOCKET_URL}...`);
            const ws = new WebSocket(WEBSOCKET_URL);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("[Telemetry] Connected.");
                if (isMounted) {
                    setConnected(true);
                    fetchStatus(); // Fetch full status on connect
                }
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data) as TelemetryEvent;
                    if (isMounted) processEvent(data);
                } catch (err) {
                    console.error("[Telemetry] Failed to parse message:", err);
                }
            };

            ws.onclose = () => {
                console.log("[Telemetry] Disconnected.");
                if (isMounted) {
                    setConnected(false);
                    // Schedule reconnect
                    reconnectTimeoutRef.current = setTimeout(connect, 3000);
                }
                wsRef.current = null;
            };

            ws.onerror = (err) => {
                console.error("[Telemetry] WebSocket error:", err);
                ws.close();
            };
        };

        connect();

        // Status Polling
        statusPollRef.current = setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);

        return () => {
            isMounted = false;
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            if (statusPollRef.current) clearInterval(statusPollRef.current);
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, [processEvent, setConnected, setOperatorStatus, clearAllTelemetry]);

    return { isConnected };
}
