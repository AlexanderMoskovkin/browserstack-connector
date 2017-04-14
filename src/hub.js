import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import { EventEmitter } from 'events';

export default class Hub extends EventEmitter {
    constructor (port) {
        super();

        this.app       = express().use(bodyParser.urlencoded({ extended: false }));
        this.appServer = http.createServer(this.app).listen(port);
        this.sockets   = [];

        this._setupRoutes();

        const handler = socket => {
            this.sockets.push(socket);

            socket.on('close', () => {
                this.sockets.splice(this.sockets.indexOf(socket), 1);
            });
        };

        this.appServer.on('connection', handler);
    }

    _setupRoutes () {
        this.app.get('/:id', (req, res) => {
            const url           = req.query.url;
            const urlIdentifier = req.params.id;

            this.emit('open', urlIdentifier);

            return res.redirect(url);
        });
    }

    close () {
        this.appServer.close();
        this.sockets.forEach(socket => {
            socket.destroy();
        });
    }
}
