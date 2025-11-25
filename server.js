const express = require('express');
const { Pool } = require('pg');         // ✅ umjesto mysql2
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Staticke slike
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// ✅ PostgreSQL konekcija (Render)
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
db.connect()
  .then(() => console.log('✅ Spojen na PostgreSQL'))
  .catch(err => console.error('❌ Greška pri spajanju na PostgreSQL:', err));

const JWT_SECRET = 'tvoj_tajni_kljuc';

// -------------------- LOGIN --------------------

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).send({ status: 'error', message: 'Korisničko ime i lozinka su obavezni!' });
    }

    const query = 'SELECT * FROM users WHERE username = $1';
    const result = await db.query(query, [username]);

    if (result.rows.length === 0) {
      return res.status(401).send({ status: 'error', message: 'Pogrešno korisničko ime.' });
    }

    const user = result.rows[0];

    // Ako user nema lozinku -> postavi ovu prvu
    if (!user.password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password = $1 WHERE id = $2', [
        hashedPassword,
        user.id
      ]);
      return res.send({ status: 'success', message: 'Lozinka postavljena! Možete se sada prijaviti ponovo.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).send({ status: 'error', message: 'Pogrešna lozinka.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isAdmin: user.isAdmin },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.send({ status: 'success', message: 'Prijava uspješna!', token });
  } catch (err) {
    console.error(err);
    res.status(500).send({ status: 'error', message: 'Greška pri prijavi.' });
  }
});

// -------------------- MULTER (SLIKE) --------------------

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/images');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage });

// -------------------- ADD NEWS --------------------

app.post('/add-news', upload.single('slika'), async (req, res) => {
  try {
    const { title, content, short, expires_at, is_pinned } = req.body;
    const slika = req.file;

    if (!title || !content || !short || !slika) {
      return res.status(400).send({ status: 'error', message: 'Svi podaci moraju biti popunjeni!' });
    }

    const imagePath = `images/${slika.filename}`;
    const pinned = is_pinned === 'true';

    const query = `
      INSERT INTO news (title, content, short, expires_at, image_path, ispinned, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `;

    await db.query(query, [
      title,
      content,
      short,
      expires_at || null,
      imagePath,
      pinned
    ]);

    res.status(200).send({ status: 'success', message: 'Novost uspješno dodata!' });
  } catch (err) {
    console.error('Greška pri unosu novosti:', err);
    res.status(500).send({ status: 'error', message: 'Došlo je do greške pri dodavanju novosti.' });
  }
});

// -------------------- BROJ OBJAVA --------------------

app.get('/get-news-count', async (req, res) => {
  try {
    const result = await db.query('SELECT COUNT(*) AS count FROM news');
    res.send({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error('Greška pri dohvatku broja objava:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri dohvatku broja objava.' });
  }
});

// -------------------- GET NEWS (paginacija) --------------------

app.get('/get-news', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const offset = (page - 1) * limit;

    const newsResult = await db.query(
      'SELECT * FROM news ORDER BY ispinned DESC, created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    const countResult = await db.query('SELECT COUNT(*) AS count FROM news');
    const totalNewsCount = Number(countResult.rows[0].count);
    const totalPages = Math.ceil(totalNewsCount / limit);

    const now = new Date();
    const novosti = newsResult.rows.map(novost => {
      const expiresAt = novost.expires_at ? new Date(novost.expires_at) : null;
      if (expiresAt && expiresAt < now) {
        return { ...novost, isExpired: true };
      } else {
        return {
          ...novost,
          isExpired: false,
          expires_in: expiresAt ? expiresAt.getTime() - now.getTime() : null
        };
      }
    });

    res.json({ novosti, totalPages });
  } catch (err) {
    console.error('Greška pri dohvatku novosti:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri dohvatku novosti.' });
  }
});

// -------------------- DELETE NEWS --------------------

app.delete('/delete-news/:id', async (req, res) => {
  try {
    const newsId = req.params.id;
    await db.query('DELETE FROM news WHERE id = $1', [newsId]);
    res.send({ status: 'success', message: '✅ Novost uspješno obrisana!' });
  } catch (err) {
    console.error('❌ Greška pri brisanju novosti:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri brisanju novosti.' });
  }
});

// -------------------- UPDATE NEWS (bez slike) --------------------

app.post('/update-news/:id', async (req, res) => {
  try {
    const { title, content, short, expires_at } = req.body;
    const id = req.params.id;

    const query = `
      UPDATE news
      SET title = $1, content = $2, short = $3, expires_at = $4
      WHERE id = $5
    `;
    await db.query(query, [title, content, short, expires_at || null, id]);

    res.json({ message: 'Novost uspješno izmijenjena!' });
  } catch (err) {
    console.error('Greška pri izmjeni novosti:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri izmjeni novosti.' });
  }
});

// -------------------- DOHVATI-NOVOSTI (drugi endpoint) --------------------

app.get('/dohvati-novosti', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 6;
    const offset = (page - 1) * limit;

    const result = await db.query(
      'SELECT * FROM news ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    res.json({ novosti: result.rows });
  } catch (err) {
    console.error('Greška pri dohvatku novosti:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri dohvatku novosti.' });
  }
});

// -------------------- DOHVATI-BROJ-NOVOSTI (drugi endpoint) --------------------

app.get('/dohvati-broj-novosti', async (req, res) => {
  try {
    const result = await db.query('SELECT COUNT(*) AS count FROM news');
    res.send({ count: Number(result.rows[0].count) });
  } catch (err) {
    console.error('Greška pri dohvatku broja novosti:', err);
    res.status(500).send({ status: 'error', message: 'Greška pri dohvatku broja novosti.' });
  }
});

// -------------------- RASPORED: UPDATE --------------------

app.post('/updateRaspored', async (req, res) => {
  try {
    const updatedRows = req.body.rows || [];

    // obrisati sve
    await db.query('DELETE FROM raspored');

    // ubaciti red po red (jednostavno – raspored je ionako mali)
    const insertSQL = `
      INSERT INTO raspored
      (ponedjeljak, ponedjeljak_time, utorak, utorak_time,
       srijeda, srijeda_time, cetvrtak, cetvrtak_time,
       petak, petak_time, subota, subota_time)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `;

    for (const row of updatedRows) {
      await db.query(insertSQL, [
        row.ponedjeljak || null, row.ponedjeljak_time || null,
        row.utorak || null, row.utorak_time || null,
        row.srijeda || null, row.srijeda_time || null,
        row.cetvrtak || null, row.cetvrtak_time || null,
        row.petak || null, row.petak_time || null,
        row.subota || null, row.subota_time || null
      ]);
    }

    console.log('Raspored uspješno ažuriran!');
    res.json({ success: true });
  } catch (err) {
    console.error('Greška pri ažuriranju rasporeda:', err);
    res.json({ success: false });
  }
});

// -------------------- RASPORED: GET --------------------

app.get('/getRaspored', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM raspored');
    res.json({ rows: result.rows });
  } catch (err) {
    console.error('Greška prilikom upita:', err);
    res.json({ success: false });
  }
});

// -------------------- EDIT NEWS (sa slikom) --------------------

app.post('/edit-news', upload.single('slika'), async (req, res) => {
  try {
    const { id, naslov, short, opis, expires_at, is_pinned } = req.body;
    let slikaPath = req.file ? 'images/' + req.file.filename : null;
    let expiresAt = expires_at ? new Date(expires_at) : null;

    if (!id || !naslov || !short || !opis) {
      return res.status(400).json({ status: 'error', message: 'Svi podaci moraju biti popunjeni!' });
    }

    // prvo uzmi postojeće podatke
    const selectResult = await db.query(
      'SELECT image_path, ispinned, expires_at FROM news WHERE id = $1',
      [id]
    );

    const existing = selectResult.rows[0];

    if (!slikaPath) {
      slikaPath = existing?.image_path || null;
    }

    let updatedIspinned = is_pinned === '1' ? true : false;

    if (!expiresAt) {
      expiresAt = existing?.expires_at || null;
    }

    const sql = `
      UPDATE news
      SET title = $1, short = $2, content = $3,
          image_path = $4, expires_at = $5, ispinned = $6
      WHERE id = $7
    `;

    await db.query(sql, [
      naslov,
      short,
      opis,
      slikaPath,
      expiresAt,
      updatedIspinned,
      id
    ]);

    res.json({ status: 'success', message: 'Novost je uspješno ažurirana.' });
  } catch (err) {
    console.error('Greška pri ažuriranju novosti:', err);
    res.status(500).json({ status: 'error', message: 'Došlo je do greške pri ažuriranju novosti.' });
  }
});

// -------------------- START SERVER --------------------

app.listen(port, () => console.log(`🚀 Server pokrenut na portu ${port}`));

