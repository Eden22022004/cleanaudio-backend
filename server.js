import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// 📁 Папка для тимчасових файлів
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer — зберігає файли в uploads/
const upload = multer({ dest: uploadsDir });

// Віддаємо файли по /uploads/...
app.use("/uploads", express.static(uploadsDir));

// 🎚 Пресети очищення
function getFiltersByPreset(preset) {
  switch ((preset || "").toLowerCase()) {
    case "soft":
      return [
        "highpass=f=80",
        "lowpass=f=9000",
        "afftdn=nr=8",
        "compand=attacks=0.5:decays=1.5:points=-80/-80|-30/-10|0/-3"
      ];
    case "hard":
      return [
        "highpass=f=180",
        "lowpass=f=5500",
        "afftdn=nr=28",
        "compand=attacks=0.2:decays=0.8:points=-80/-80|-35/-20|0/-8"
      ];
    case "medium":
    default:
      return [
        "highpass=f=150",
        "lowpass=f=6500",
        "afftdn=nr=20",
        "compand=attacks=0.3:decays=1:points=-80/-80|-30/-15|0/-5"
      ];
  }
}

// 🎛 Основний маршрут очищення
app.post("/api/clean", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Файл не завантажено" });
    }

    const preset = req.body.preset || "medium";

    const inputPath = req.file.path;
    const outputFileName = `cleaned-${Date.now()}.wav`;
    const outputPath = path.join(uploadsDir, outputFileName);

    console.log("🔊 Файл отримано:", inputPath, "| пресет:", preset);

    const filters = getFiltersByPreset(preset);

    // 1) Чекаємо, поки ffmpeg доробить файл
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioFilters(filters)
        .outputOptions(["-ar 44100", "-ac 1"])
        .toFormat("wav")
        .on("end", () => {
          console.log("✅ FFmpeg завершив обробку:", outputPath);
          resolve();
        })
        .on("error", (err) => {
          console.error("❌ FFmpeg помилка:", err);
          reject(err);
        })
        .save(outputPath);
    });

    // 2) Читаємо файл у буфер
    const fileBuffer = fs.readFileSync(outputPath);

    // 3) Формуємо шлях у бакеті
    const bucketName = "cleaned-audio"; // твій bucket
    const fileNameInBucket = `cleaned/${outputFileName}`;

    // 4) Завантажуємо в Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(fileNameInBucket, fileBuffer, {
        contentType: "audio/wav",
        upsert: false, // якщо хочеш дозволити перезапис — постав true
      });

    if (uploadError) {
      console.error("❌ Помилка завантаження в Supabase Storage:", uploadError);
      return res.status(500).json({
        error: "Помилка завантаження в сховище",
        details: uploadError.message,
      });
    }

    // 5) Отримуємо public URL
    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileNameInBucket);

    const publicUrl = publicUrlData?.publicUrl;

    console.log("🌐 Public URL:", publicUrl);

    if (!publicUrl) {
      return res.status(500).json({
        error: "Не вдалося отримати публічний URL",
      });
    }

    // (опціонально) можемо видалити локальний файл
    try {
      fs.unlinkSync(outputPath);
      fs.unlinkSync(inputPath);
    } catch (e) {
      console.warn("⚠ Не вдалося видалити тимчасові файли:", e.message);
    }

    // 6) Віддаємо вже готовий public URL фронту
    return res.json({
      cleanedFile: publicUrl,
      preset,
    });
  } catch (err) {
    console.error("❌ Помилка /api/clean:", err);
    return res.status(500).json({
      error: "Помилка обробки аудіо",
      details: err.message,
    });
  }
});


// 🧪 Тестова сторінка (тимчасово, для дебагу)
app.get("/", (req, res) => {
  res.send(`
    <h1>CleanAudio API (backend only)</h1>
    <p>Це тестовий бекенд. Можеш надсилати POST /api/clean з FormData.</p>
  `);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`🚀 Backend started at http://localhost:${PORT}`);
});

