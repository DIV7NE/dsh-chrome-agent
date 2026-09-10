/** Options page: the DSH server port, and a manual reconnect. */
const DEFAULT_PORT = 3080;

const portInput = document.getElementById('port');
const stateBox = document.getElementById('state');

/** Chrome derives the id from the manifest key; show it so the user can compare with chrome_status. */
function extensionId() {
  return new Promise(resolve => chrome.runtime.sendMessage({ type: 'id' }, id => resolve(id)));
}

async function refresh() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT });
  portInput.value = String(stored.port || DEFAULT_PORT);
  const id = chrome.runtime.id;
  document.getElementById('id').textContent = id;
  stateBox.textContent = 'Extension id ' + id + '. Saving reconnects to the server on port ' + portInput.value + '.';
  stateBox.className = '';
}

document.getElementById('save').addEventListener('click', async () => {
  const port = Number(portInput.value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    stateBox.textContent = 'Enter a port between 1 and 65535.';
    stateBox.className = 'bad';
    return;
  }
  await chrome.storage.local.set({ port: port });
  stateBox.textContent = 'Saved. Reconnecting to 127.0.0.1:' + port + ' …';
  stateBox.className = '';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'reconnect' });
    stateBox.textContent = reply && reply.ok
      ? 'Reconnecting to 127.0.0.1:' + port + '. Load a tab and ask the agent to run chrome_status.'
      : 'Saved, but the worker did not answer. Reload the extension from chrome://extensions.';
    stateBox.className = reply && reply.ok ? 'ok' : 'bad';
  } catch (error) {
    stateBox.textContent = 'Saved, but the worker did not answer: ' + String(error);
    stateBox.className = 'bad';
  }
});

refresh();
