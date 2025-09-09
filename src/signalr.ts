import * as signalR from '@microsoft/signalr';
import { MessagePackHubProtocol } from '@microsoft/signalr-protocol-msgpack';

let connection: signalR.HubConnection | null = null;

export function getHub() {
    if (!connection) {
        connection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/edit')
            .withHubProtocol(new MessagePackHubProtocol())
            .withAutomaticReconnect()
            .build();
    }
    return connection;
}
