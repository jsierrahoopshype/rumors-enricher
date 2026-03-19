chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "offscreen-copy") {
    const el = document.getElementById("cb");
    el.value = message.text;
    el.select();
    document.execCommand("copy");
  }
});
