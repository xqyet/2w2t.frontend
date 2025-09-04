import * as signalR from '@microsoft/signalr';

let connection: signalR.HubConnection | null = null;

export function getHub() {
    if (!connection) {
        connection = new signalR.HubConnectionBuilder()
            .withUrl('/hubs/edit') // proxied to backend
            .withAutomaticReconnect()
            .build();
    }
    return connection;
}
