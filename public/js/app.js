// app.js — router between the Connect and Controller screens.
//
// The app holds exactly one session at a time. When a session ends — by
// user action or because the server reaped it — we tear the controller down
// and return to the connect screen, preserving host/port/username if the
// user asked us to remember them.

import { renderConnect } from './views/connect.js';
import { renderController } from './views/controller.js';

const root = document.getElementById('app');

let currentTeardown = null;

function mount(teardown) {
  if (currentTeardown) currentTeardown();
  root.replaceChildren();
  currentTeardown = teardown;
}

function showConnect(prefillError = null) {
  mount(renderConnect(root, {
    onConnected(session) {
      showController(session);
    },
    prefillError,
  }));
}

function showController(session) {
  mount(renderController(root, {
    session,
    onDisconnect(reason) {
      showConnect(reason || null);
    },
  }));
}

showConnect();
