const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// -------------------- DATABASE --------------------
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

db.connect()
  .then(() => console.log('✅ Spojen na PostgreSQL'))
  .catch(err => console.error('❌ Greška pri spajanju:', err));

const JWT_SECRET = 'tvoj_tajni_kljuc';

// -------------------- LOGIN --------------------
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ status: 'error', message: 'Polja su obavezna' });

    const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0)
      return res.status(401).json({ status: 'error', message: 'Pogrešno korisničko ime.' });

    const user = result.rows[0];

    // Prvi login → postavi lozinku
    if (!user.password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = $1 WHERE id = $2', [hash, user.id]);
      return res.json({ status: 'success', message: 'Lozinka postavljena. Prijavite se ponovo.' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)
      return res.status(401).json({ status: 'error', message: 'Pogrešna lozinka.' });

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.isadmin },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ status: 'success', token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: 'Greška na serveru.' });
  }
});

// -------------------- ADD NEWS --------------------
app.post('/add-news', async (req, res) => {
  try {
    const { title, content, short, expires_at, is_pinned, image_path } = req.body;

    if (!title || !content || !short || !image_path)
      return res.status(400).json({ status: 'error', message: 'Svi podaci moraju biti popunjeni.' });

    const pinned = is_pinned === 'true';

    const expiresAtValue =
      typeof expires_at === 'string' && expires_at.length > 10 ? expires_at : null;

    const query = `
      INSERT INTO news (title, content, short, expires_at, image_path, ispinned, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `;

    await db.query(query, [
      title,
      content,
      short,
      expiresAtValue,
      image_path, // 👈 CDN URL iz Uploadcare
      pinned
    ]);

    res.json({ status: 'success', message: 'Novost dodana!' });
  } catch (err) {
    console.error('Greška pri unosu:', err);
    res.status(500).json({ status: 'error', message: 'Greška pri dodavanju novosti.' });
  }
});

// -------------------- GET NEWS COUNT --------------------
app.get('/get-news-count', async (req, res) => {
  try {
    const result = await db.query('SELECT COUNT(*) AS count FROM news');
    res.json({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// -------------------- GET NEWS --------------------
app.get('/get-news', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const offset = (page - 1) * limit;

    const newsResult = await db.query(
      'SELECT * FROM news ORDER BY ispinned DESC, created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    const totalCount = await db.query('SELECT COUNT(*) AS count FROM news');
    const totalPages = Math.ceil(Number(totalCount.rows[0].count) / limit);

    const now = new Date();
    const novosti = newsResult.rows.map(n => {
      const exp = n.expires_at ? new Date(n.expires_at) : null;
      return {
        ...n,
        isExpired: exp ? exp < now : false,
        expires_in: exp ? exp.getTime() - now.getTime() : null
      };
    });

    res.json({ novosti, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// -------------------- DELETE NEWS --------------------
app.delete('/delete-news/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM news WHERE id = $1', [req.params.id]);
    res.json({ status: 'success', message: 'Novost obrisana.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// -------------------- UPDATE NEWS (bez slike) --------------------
app.post('/update-news/:id', async (req, res) => {
  try {
    const { title, content, short, expires_at } = req.body;
    const id = req.params.id;

    await db.query(
      `UPDATE news SET title=$1, content=$2, short=$3, expires_at=$4 WHERE id=$5`,
      [title, content, short, expires_at || null, id]
    );

    res.json({ message: 'Novost izmijenjena.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// -------------------- UPDATE NEWS (sa novom slikom preko CDN URL-a) --------------------
app.post('/edit-news', async (req, res) => {
  try {
    const { id, naslov, short, opis, expires_at, is_pinned, image_path } = req.body;

    if (!id || !naslov || !short || !opis)
      return res.status(400).json({ status: 'error', message: 'Polja su obavezna.' });

    const existing = await db.query('SELECT * FROM news WHERE id=$1', [id]);
    if (existing.rows.length === 0)
      return res.status(404).json({ status: 'error', message: 'Ne postoji.' });

    const old = existing.rows[0];

    const finalImage = image_path || old.image_path;
    const finalPinned =
      typeof is_pinned !== 'undefined'
        ? is_pinned === 'true' || is_pinned === '1'
        : old.ispinned;

    let expiresAtVal = old.expires_at;
    if (typeof expires_at !== 'undefined') {
      if (expires_at === '' || expires_at === null) expiresAtVal = null;
      else if (expires_at.length > 10) expiresAtVal = new Date(expires_at);
    }

    await db.query(
      `UPDATE news SET title=$1, short=$2, content=$3, image_path=$4, expires_at=$5, ispinned=$6 WHERE id=$7`,
      [naslov, short, opis, finalImage, expiresAtVal, finalPinned, id]
    );

    res.json({ status: 'success', message: 'Izmijenjeno.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error' });
  }
});

// -------------------- RASPORED UPDATE --------------------
app.post('/updateRaspored', async (req, res) => {
  try {
    const rows = req.body.rows || [];
    await db.query('DELETE FROM raspored');

    const sql = `
      INSERT INTO raspored
      (ponedjeljak, ponedjeljak_time, utorak, utorak_time,
       srijeda, srijeda_time, cetvrtak, cetvrtak_time,
       petak, petak_time, subota, subota_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `;

    for (const r of rows) {
      await db.query(sql, [
        r.ponedjeljak || null, r.ponedjeljak_time || null,
        r.utorak || null, r.utorak_time || null,
        r.srijeda || null, r.srijeda_time || null,
        r.cetvrtak || null, r.cetvrtak_time || null,
        r.petak || null, r.petak_time || null,
        r.subota || null, r.subota_time || null
      ]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// -------------------- GET RASPORED --------------------
app.get('/getRaspored', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM raspored');
    res.json({ rows: result.rows });
  } catch (err) {
    console.error(err);
    res.json({ success: false });
  }
});

// -------------------- START --------------------
app.listen(port, () => console.log(`🚀 Server radi na portu ${port}`));
