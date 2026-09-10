'use strict';

const vscode = require('vscode');

/** Arbol de conexiones del panel lateral. */
class ConnectionsProvider {
    constructor(store) {
        this.store = store;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        store.onDidChange(() => this.refresh());
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(el) {
        return el;
    }

    getChildren(el) {
        if (el) return [];
        const activeId = this.store.activeId();
        return this.store.all().map((c) => {
            const isActive = c.id === activeId;
            const item = new vscode.TreeItem(
                c.name,
                vscode.TreeItemCollapsibleState.None
            );
            item.id = c.id;
            item.description = new URL(c.pod).host;
            item.tooltip = new vscode.MarkdownString(
                `**${c.name}**\n\n` +
                `- Pod: \`${c.pod}\`\n` +
                `- Usuario: \`${c.user}\`\n` +
                `- Carpeta: \`${c.folder}\`\n` +
                `- Data source: \`${c.dataSource}\``
            );
            item.contextValue = 'connection';
            item.iconPath = new vscode.ThemeIcon(
                isActive ? 'circle-filled' : 'circle-outline',
                isActive ? new vscode.ThemeColor('charts.green') : undefined
            );
            item.command = {
                command: 'OracleERPBIPublisherRunner.setActiveConnection',
                title: 'Usar esta conexión',
                arguments: [item],
            };
            return item;
        });
    }
}

/** Historial de consultas de la sesion, persistido en globalState. */
class HistoryProvider {
    constructor(context) {
        this.context = context;
        this.KEY = 'OracleERPBIPublisherRunner.history';
        this.MAX = 50;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    all() {
        return this.context.globalState.get(this.KEY, []);
    }

    async add(entry) {
        const list = [entry, ...this.all()].slice(0, this.MAX);
        await this.context.globalState.update(this.KEY, list);
        this._onDidChangeTreeData.fire();
    }

    async clear() {
        await this.context.globalState.update(this.KEY, []);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(el) {
        return el;
    }

    getChildren(el) {
        if (el) return [];
        return this.all().map((h, i) => {
            const oneLine = h.sql.replace(/\s+/g, ' ').trim();
            const item = new vscode.TreeItem(
                oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine,
                vscode.TreeItemCollapsibleState.None
            );
            item.id = `h${i}`;
            item.description = h.ok ? `${h.rows} filas · ${h.ms} ms` : 'error';
            item.tooltip = new vscode.MarkdownString(
                `\`\`\`sql\n${h.sql}\n\`\`\`\n\n` +
                `${new Date(h.at).toLocaleString()}`
            );
            item.contextValue = 'historyItem';
            item.iconPath = new vscode.ThemeIcon(h.ok ? 'check' : 'error');
            item.command = {
                command: 'OracleERPBIPublisherRunner.rerunFromHistory',
                title: 'Reejecutar',
                arguments: [{ sql: h.sql }],
            };
            return item;
        });
    }
}

module.exports = { ConnectionsProvider, HistoryProvider };
