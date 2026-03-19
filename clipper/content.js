document.addEventListener("mouseup", () => {
  const text = window.getSelection().toString().trim();
  if (text.length > 10) {
    const payload = text + "\n\n" + window.location.href + "\n\n";
    navigator.clipboard.writeText(payload).catch(() => {
      fallbackCopy(payload);
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
