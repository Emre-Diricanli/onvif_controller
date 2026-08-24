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

/**
 * Swap the mounted screen.
 *
 * Takes a render *function*, not a rendered result: the previous screen has to
 * be torn down and the root cleared BEFORE the next screen renders into it.
 * Passing `render(root)` directly would populate the root and then have it
 * wiped by the clear that follows.
 */
function mount(render) {
  if (currentTeardown) currentTeardown();
  currentTeardown = null;
  root.replaceChildren();
  currentTeardown = render();
}

function showConnect(prefillError = null) {
  mount(() => renderConnect(root, {
    onConnected(session) {
      showController(session);
    },
    prefillError,
  }));
}

function showController(session) {
  mount(() => renderController(root, {
    session,
    onDisconnect(reason) {
      showConnect(reason || null);
    },
  }));
}

showConnect();
