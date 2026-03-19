document.addEventListener("mouseup", () => {
  const text = window.getSelection().toString().trim();
  if (text.length > 10) {
    const payload = text + "\n\n" + window.location.href + "\n";
    chrome.runtime.sendMessage({ type: "copy", payload });
  }
});
