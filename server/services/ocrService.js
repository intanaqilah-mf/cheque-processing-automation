const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const moment = require('moment');
const fs = require('fs');

// NEW HELPER: Converts image file to a Generative AI part object
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType
        },
    };
}

// UPDATED HELPER: Calls Gemini with the image and a targeted prompt
const callGeminiVisionAPI = async (imagePath) => {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
        Analyze the following image of a bank cheque. Extract the following information and return it as a clean JSON object. Do not include any markdown or explanatory text outside the JSON.
        - payeeName: The name of the person or company to be paid.
        - payerName: The name of the person signing or issuing the cheque (often a standalone name near the signature line).
        - amountInWords: The full written amount in words.
        - chequeDate: The date on the cheque, formatted as DD-MM-YYYY.

        The JSON object must have these exact keys: "payeeName", "payerName", "amountInWords", "chequeDate".
        If a value is unclear, use "N/A".
    `;

    try {
        const imagePart = fileToGenerativePart(imagePath, "image/jpeg");
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const fullResponseText = response.text();
        
        const jsonMatch = fullResponseText.match(/\{[\s\S]*\}/);
        if (jsonMatch && jsonMatch[0]) {
            return JSON.parse(jsonMatch[0]);
        } else {
            throw new Error("No valid JSON object found in Gemini Vision response.");
        }
    } catch (error) {
        console.error('Error calling or parsing Gemini Vision API:', error);
        return null;
    }
};


// REWRITTEN processCheque function
const processCheque = async (imagePath) => {
    // =================================================================
    // STEP 1: Get structured data directly from Gemini Vision
    // =================================================================
    const visionData = await callGeminiVisionAPI(imagePath);

    const data = {
        payeeName: visionData?.payeeName || 'N/A',
        payerName: visionData?.payerName || 'N/A',
        amountInWords: visionData?.amountInWords || 'N/A',
        chequeDate: visionData?.chequeDate || 'N/A', // Using Gemini's result for the date
        amount: 0,
        micr: { raw: 'N/A', chequeNo: 'N/A', bankCode: 'N/A', branchCode: 'N/A', payerAccountNo: 'N/A', tranCode: 'N/A' },
        bankBranchCodeCenter: 'N/A',
        needsReview: true,
        reviewNotes: [],
    };

    // =================================================================
    // STEP 2: Use regex ONLY for simple, highly structured fields
    // =================================================================
    const client = new ImageAnnotatorClient();
    const [result] = await client.textDetection(imagePath);
    let rawText = result.fullTextAnnotation?.text;

    if (!rawText) {
        data.needsReview = true;
        data.reviewNotes.push("Could not extract any OCR text from image.");
        return { ...data, rawText: "OCR FAILED" };
    }
    
    const lines = rawText.split('\n');

    // --- Amount (Figures) Extraction ---
    const rawAmountMatch = rawText.match(/RM\s*([0-9,]+(?:[.x\s]*\d*))/i);
    if (rawAmountMatch && rawAmountMatch[1]) {
        const cleanedAmountStr = rawAmountMatch[1].replace(/[^0-9.]/g, '');
        if (cleanedAmountStr) {
            data.amount = parseFloat(cleanedAmountStr);
        }
    }

    // --- Refined Date Extraction Block is now REMOVED ---

    // --- Refined MICR Line Extraction ---
    const micrLineCandidate = lines.find(line => (line.match(/\d/g) || []).length > 15);
    if (micrLineCandidate) {
        data.micr.raw = micrLineCandidate.trim();
        // Simplified MICR parsing can be added here if needed
    }

    // --- Final Review Check (simplified) ---
    if (data.payeeName === 'N/A') data.reviewNotes.push("Payee Name not found by Vision API.");
    if (data.payerName === 'N/A') data.reviewNotes.push("Payer Name not found by Vision API.");
    if (data.chequeDate === 'N/A') data.reviewNotes.push("Date not found by Vision API.");
    if (data.amount === 0) data.reviewNotes.push("Amount could not be parsed.");
    if (data.reviewNotes.length > 0) data.needsReview = true;

    return { ...data, rawText };
};

module.exports = { processCheque };