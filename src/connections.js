'use strict';

/**
 * Almacen de conexiones.
 *
 * Los datos no sensibles van a globalState; las contrasenas SIEMPRE a
 * SecretStorage, que en VS Code se respalda en el llavero del sistema
 * operativo. Nunca en settings.json ni en el workspace, que acaban en git.
 */

const vscode = require('vscode');

const KEY = 'OracleERPBIPublisherRunner.connections';
const ACTIVE = 'OracleERPBIPublisherRunner.activeConnection';

class ConnectionStore {
    constructor(context) {
        this.context = context;
        this._onDidChange = new vscode.EventEmitter();
        this.onDidChange = this._onDidChange.event;
    }

    all() {
        return this.context.globalState.get(KEY, []);
    }

    get(id) {
        return this.all().find((c) => c.id === id);
    }

    activeId() {
        return this.context.globalState.get(ACTIVE);
    }

    active() {
        const id = this.activeId();
        return id ? this.get(id) : this.all()[0];
    }

    async setActive(id) {
        await this.context.globalState.update(ACTIVE, id);
        this._onDidChange.fire();
    }

    async save(conn, password) {
        const list = this.all();
        const i = list.findIndex((c) => c.id === conn.id);
        if (i >= 0) list[i] = conn; else list.push(conn);
        await this.context.globalState.update(KEY, list);
        if (password !== undefined && password !== null && password !== '') {
            await this.context.secrets.store(`${KEY}.${conn.id}`, password);
        }
        if (!this.activeId()) await this.context.globalState.update(ACTIVE, conn.id);
        this._onDidChange.fire();
        return conn;
    }

    async remove(id) {
        await this.context.globalState.update(KEY, this.all().filter((c) => c.id !== id));
        await this.context.secrets.delete(`${KEY}.${id}`);
        if (this.activeId() === id) {
            await this.context.globalState.update(ACTIVE, this.all()[0]?.id);
        }
        this._onDidChange.fire();
    }

    async password(id) {
        return this.context.secrets.get(`${KEY}.${id}`);
    }
}

module.exports = { ConnectionStore };
