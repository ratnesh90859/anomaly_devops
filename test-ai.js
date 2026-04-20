const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
ai.models.generateContent({ model: 'gemini-2.5-flash', contents: 'Hello' })
  .then(res => console.log("SUCCESS: " + res.text))
  .catch(err => console.log("ERROR: " + err.message));
