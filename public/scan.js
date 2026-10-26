// Reading QR codes: from the camera or from a photo/screenshot, then turning what they contain into contact fields.
// Handles a contact card (vCard / MECARD, e.g. someone's own QR card), LinkedIn and Telegram profile links, WhatsApp, mailto/tel and plain websites.
(() => {
  'use strict';
  const unesc = (s) => String(s).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

  // "benedikt-rutter-1a2b3c4d" -> "Benedikt Rutter": LinkedIn adds a random id to many profile addresses.
  function nameFromSlug(slug) {
    let parts = decodeURIComponent(slug).split(/[-_.]+/).filter(Boolean);
    if (parts.length > 1 && /\d/.test(parts[parts.length - 1]) && parts[parts.length - 1].length >= 5) parts = parts.slice(0, -1);
    if (parts.length < 2 || parts.some((p) => /\d/.test(p))) return '';
    return parts.map(cap).join(' ');
  }

  function fromVCard(text) {
    const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const f = { name: '', company: '', phone: '', email: '', role: '', linkedin: '', telegram: '', website: '' };
    for (const raw of lines) {
      const m = raw.match(/^(?:[\w-]+\.)?([A-Za-z-]+)(?:;[^:]*)?:(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase(), val = m[2];
      if (key === 'FN' && !f.name) f.name = unesc(val);
      else if (key === 'N' && !f.name) { const [last, first] = val.split(';'); f.name = [first, last].map((x) => unesc(x || '')).filter(Boolean).join(' '); }
      else if (key === 'ORG' && !f.company) f.company = unesc(val.split(';')[0]);
      else if (key === 'TITLE' && !f.role) f.role = unesc(val);
      else if (key === 'TEL' && !f.phone) f.phone = unesc(val);
      else if (key === 'EMAIL' && !f.email) f.email = unesc(val);
      else if (key === 'URL') {
        const u = unesc(val);
        if (/linkedin\.com|lnkd\.in/i.test(u) && !f.linkedin) f.linkedin = u;
        else if (/(^|\/\/|\.)(t|telegram)\.me\//i.test(u) && !f.telegram) f.telegram = u;
        else if (!f.website) f.website = u;
      }
    }
    return f;
  }

  function fromMeCard(text) {
    const f = { name: '', company: '', phone: '', email: '', role: '', linkedin: '', telegram: '', website: '' };
    for (const part of text.replace(/^MECARD:/i, '').split(/(?<!\\);/)) {
      const i = part.indexOf(':'); if (i < 0) continue;
      const key = part.slice(0, i).toUpperCase(), val = unesc(part.slice(i + 1));
      if (key === 'N') f.name = val.split(',').reverse().map((x) => x.trim()).filter(Boolean).join(' ');
      else if (key === 'TEL' && !f.phone) f.phone = val;
      else if (key === 'EMAIL' && !f.email) f.email = val;
      else if (key === 'ORG') f.company = val;
      else if (key === 'URL' && !f.website) f.website = val;
    }
    return f;
  }

  /** What a scanned code contains: { label, fields, hint } or null when it is not something to file. */
  function parse(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const blank = { name: '', company: '', phone: '', email: '', role: '', linkedin: '', telegram: '', website: '' };
    if (/^BEGIN:VCARD/i.test(text)) { const fields = fromVCard(text); return fields.name ? { label: 'a contact card', fields, hint: '' } : { label: 'a contact card', fields, hint: 'The card has no name. Type it in.' }; }
    if (/^MECARD:/i.test(text)) return { label: 'a contact card', fields: fromMeCard(text), hint: '' };
    if (/^mailto:/i.test(text)) return { label: 'an email address', fields: { ...blank, email: text.replace(/^mailto:/i, '').split('?')[0] }, hint: 'Type the name.' };
    if (/^tel:/i.test(text)) return { label: 'a phone number', fields: { ...blank, phone: text.replace(/^tel:/i, '') }, hint: 'Type the name.' };
    if (/^tg:\/\/resolve/i.test(text)) return { label: 'a Telegram profile', fields: { ...blank, telegram: text }, hint: 'Telegram only shares the username. Type their name.' };
    if (/\s/.test(text)) return null; // plain text, not an address
    let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text); } catch { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!u.hostname.includes('.')) return null;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 't.me' || host === 'telegram.me') {
      if (/^\/(\+|joinchat)/i.test(u.pathname)) return { label: 'a Telegram group invite', fields: blank, hint: 'That is a group invite, not a person. Nothing to add.' , reject: true };
      return { label: 'a Telegram profile', fields: { ...blank, telegram: u.href }, hint: 'Telegram only shares the username. Type their name.' };
    }
    if (host === 'wa.me' || host === 'api.whatsapp.com') {
      const digits = (host === 'wa.me' ? u.pathname.slice(1) : u.searchParams.get('phone') || '').replace(/\D/g, '');
      if (digits) return { label: 'a WhatsApp number', fields: { ...blank, phone: '+' + digits }, hint: 'Type the name.' };
    }
    if (host === 'linkedin.com' || host.endsWith('.linkedin.com') || host === 'lnkd.in') {
      const slug = u.pathname.match(/^\/(?:in|pub)\/([^/?#]+)/i)?.[1];
      const name = slug ? nameFromSlug(slug) : '';
      const link = slug ? 'https://www.linkedin.com/in/' + slug : u.origin + u.pathname;
      return { label: 'a LinkedIn profile', fields: { ...blank, linkedin: link, name }, hint: name ? 'The name comes from the LinkedIn address. Check it.' : 'LinkedIn does not share the name in the code. Type it; the profile link is saved so you can enrich it later.' };
    }
    return { label: 'a website', fields: { ...blank, website: u.href }, hint: 'Type the name.' };
  }

  async function decodeImage(file) {
    const bmp = await createImageBitmap(file);
    for (const max of [1200, 2000, 700]) {
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, w, h);
      const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      if (hit) return hit.data;
    }
    return null;
  }

  /** Open the camera overlay and resolve with the text of the first QR code seen, or null when cancelled. */
  function scanCamera(ui) {
    return new Promise((resolve) => {
      let stream, raf = 0, done = false;
      const video = ui.video, canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
      const finish = (v) => { if (done) return; done = true; cancelAnimationFrame(raf); stream && stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; ui.root.classList.add('hidden'); resolve(v); };
      ui.cancel.onclick = () => finish(null);
      ui.root.classList.remove('hidden'); ui.msg.textContent = 'Point the camera at the QR code.';
      ui.fromFile.onchange = async () => {
        const f = ui.fromFile.files[0]; ui.fromFile.value = ''; if (!f) return;
        ui.msg.textContent = 'Reading…';
        try { const t = await decodeImage(f); if (t) finish(t); else ui.msg.textContent = 'No QR code found in that image. Try another one, or the camera.'; }
        catch { ui.msg.textContent = 'That image could not be read.'; }
      };
      (async () => {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
          if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
          video.srcObject = stream; await video.play();
          const tick = () => {
            if (done) return;
            if (video.readyState >= 2 && video.videoWidth) {
              const k = Math.min(1, 800 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const hit = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
              if (hit && hit.data) { try { navigator.vibrate && navigator.vibrate(40); } catch { /* optional */ } return finish(hit.data); }
            }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch (e) {
          ui.msg.textContent = e && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser, or pick a photo or screenshot of the code below.' : 'No camera available. Pick a photo or screenshot of the code below.';
        }
      })();
    });
  }

  window.CCScan = { parse, decodeImage, scanCamera, nameFromSlug };
})();
