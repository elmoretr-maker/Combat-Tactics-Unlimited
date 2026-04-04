export async function loadJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error("Failed " + path + " " + r.status);
  return r.json();
}
