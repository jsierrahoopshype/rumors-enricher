document.addEventListener("mouseup", () => {
  const text = window.getSelection().toString().trim();
  if (text.length > 10) {
    const payload = text + "\n\n" + window.location.href + "\n\n";
    navigator.clipboard.writeText(payload).then(showToast).catch(() => {
      fallbackCopy(payload);
      showToast();
    });
  }
});

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function showToast() {
  const toast = document.createElement("div");
  toast.textContent = "Copied!";
  toast.style.cssText =
    "position:fixed;bottom:24px;right:24px;background:rgba(0,0,0,0.8);" +
    "color:#fff;padding:8px 18px;border-radius:20px;font:14px/1 sans-serif;" +
    "z-index:2147483647;opacity:1;transition:opacity 0.3s;pointer-events:none;";
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; }, 1200);
  setTimeout(() => { toast.remove(); }, 1500);
}
