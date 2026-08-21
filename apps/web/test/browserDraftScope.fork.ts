// Browser test files share an origin. Orphan adoption must not import a previous file's
// drafts into the next file's fresh composer store; upstream has no window buckets to clear.
for (const key of Object.keys(localStorage)) {
  if (key.startsWith("t3code:composer-drafts:v1:window:")) localStorage.removeItem(key);
}
sessionStorage.removeItem("t3code:composer-drafts:window-scope");
