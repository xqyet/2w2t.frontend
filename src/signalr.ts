import * as signalR from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

let connection: signalR.HubConnection | null = null;

export function getHub() {
    if (!connection) {
        connection = new signalR.HubConnectionBuilder()
            // force WebSockets now (no fallback to long-polling which resulted in delayed real-time)
            .withUrl('/hubs/edit', { transport: signalR.HttpTransportType.WebSockets })

            // MessagePack for smaller / faster binary messages
            .withHubProtocol(new MessagePackHubProtocol())
            .withAutomaticReconnect()
            .configureLogging(signalR.LogLevel.Warning)
            .build();
    }
    return connection;
}
