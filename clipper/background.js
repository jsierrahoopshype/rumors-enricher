chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "copy") {
    copyToClipboard(message.payload);
  }
});

async function copyToClipboard(text) {
  // Use the offscreen document API to write to the clipboard
  // since service workers don't have direct DOM/clipboard access.
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: "Write selected text to clipboard"
    });
  } catch {
    // Document may already exist
  }

  chrome.runtime.sendMessage({ type: "offscreen-copy", text });
}
