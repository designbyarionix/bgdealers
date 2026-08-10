import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { runLocal } from './local_main.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

app.get('/api/sample-input', async (req, res) => {
    try {
        const sample = await fs.readFile(path.join(__dirname, 'local_input.json'), 'utf8');
        return res.json(JSON.parse(sample));
    } catch (err) {
        return res.status(500).json({ error: 'Unable to load sample input', message: err.message });
    }
});

app.post('/api/run', async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object') {
        return res.status(400).json({ error: 'Invalid input payload' });
    }

    try {
        const result = await runLocal(input, null);
        return res.json({ status: 'ok', result });
    } catch (err) {
        return res.status(500).json({ status: 'error', message: err.message, stack: err.stack });
    }
});

app.listen(port, () => {
    console.log(`Web UI running at http://localhost:${port}`);
});
