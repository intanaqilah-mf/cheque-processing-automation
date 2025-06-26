const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const moment = require('moment');
const fs = require('fs');

// Helper: Converts image file to a Generative AI part object
function fileToGenerativePart(path, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(path)).toString("base64"),
            mimeType
        },
    };
}

// HELPER: Asks Gemini for values AND confidence scores
const callGeminiVisionAPI = async (imagePath) => {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
        Analyze the bank cheque image. For "payeeName", "amountInWords", "chequeDate", and "amount", provide a detailed object containing the "value", a "confidence" score (0-100), and a brief "reason" for that score. For all other fields, provide the direct value. Return a clean JSON object without any markdown.

        - "payeeName": { "value": "...", "confidence": ..., "reason": "..." }
        - "payerName": "..."
        - "payerAccountNo": "..."
        - "amount": { "value": ..., "confidence": ..., "reason": "..." }
        - "amountInWords": { "value": "...", "confidence": ..., "reason": "..." }
        - "chequeDate": { "value": "DD-MM-YYYY", "confidence": ..., "reason": "..." }
        - "hasSignature": boolean
        - "bankBranchCodeCenter": "..."
        - "micr": { "cdv": "...", "chequeNo": "...", "bankCode": "...", "branchCode": "...", "payerAccountNo": "...", "tranCode": "..." }

        Confidence reason should be brief, e.g., "Clear printed text", "Slightly unclear handwriting".
        If a value is unclear, use "N/A", set confidence to a low value, and default hasSignature to true.
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

// Main processing function with finalized logic
const processCheque = async (imagePath) => {
    // Step 1: Get the initial analysis from Gemini Vision
    const visionData = await callGeminiVisionAPI(imagePath);

    const data = {
        payeeName: visionData?.payeeName?.value || 'N/A',
        payerName: visionData?.payerName || 'N/A',
        payerAccountNo: visionData?.payerAccountNo || 'N/A',
        amount: visionData?.amount?.value || 0, // UPDATED: To handle nested amount object
        amountInWords: visionData?.amountInWords?.value || 'N/A',
        chequeDate: visionData?.chequeDate?.value || 'N/A',
        hasSignature: visionData?.hasSignature ?? true,
        bankBranchCodeCenter: visionData?.bankBranchCodeCenter || 'N/A',
        micr: { // Initialize with defaults, will be overwritten by regex
            cdv: 'N/A',
            chequeNo: 'N/A',
            bankCode: 'N/A',
            branchCode: 'N/A',
            payerAccountNo: 'N/A',
            tranCode: 'N/A'
        },
        needsReview: false, 
        reviewNotes: [],
    };
    
    // Step 2: Get raw text for precise regex extraction
    const client = new ImageAnnotatorClient();
    const [result] = await client.textDetection(imagePath);
    const rawText = result.fullTextAnnotation?.text || "";
    const lines = rawText.split('\n');

    // =================================================================
    // Regex-Primary Extraction for Specific Fields (as requested)
    // =================================================================

    // --- Bank/Branch Code (Center) ---
    const bankBranchMatch = rawText.match(/\b(\d{2}-\d{5})\b/);
    if (bankBranchMatch && bankBranchMatch[1]) {
        data.bankBranchCodeCenter = bankBranchMatch[1];
    }

    // --- Payer Account No (under name) ---
    if (data.payerName !== 'N/A') {
        const payerNameIndex = lines.findIndex(line => line.trim().toUpperCase().includes(data.payerName.toUpperCase()));
        if (payerNameIndex !== -1 && payerNameIndex + 1 < lines.length) {
            const nextLine = lines[payerNameIndex + 1].trim();
            if (/^\d{10,}$/.test(nextLine)) {
                data.payerAccountNo = nextLine;
            }
        }
    }

    // --- MICR Line Parsing ---
    const micrLine = lines.find(line => (line.match(/\d/g) || []).length > 15 && (line.includes('⑆') || line.includes('⑈')));
    if (micrLine) {
        const cleanedMicr = micrLine.replace(/[^\d\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const parts = cleanedMicr.split(' ');
        
        if (parts.length >= 6) {
             data.micr.cdv = parts[0];
             data.micr.chequeNo = parts[1];
             data.micr.bankCode = parts[2];
             data.micr.branchCode = parts[3];
             data.micr.payerAccountNo = parts[4];
             data.micr.tranCode = parts[parts.length - 1];
        }
    }
    
    // =================================================================
    // Confidence and Data Quality Checks for n8n Alerts
    // =================================================================
    const confidenceThreshold = 90;

    if (visionData?.payeeName?.confidence < confidenceThreshold) {
        data.reviewNotes.push(`Low confidence for Payee Name (<90%): ${visionData.payeeName.reason}`);
    }
    if (visionData?.amountInWords?.confidence < confidenceThreshold) {
        data.reviewNotes.push(`Low confidence for Amount in Words (<90%): ${visionData.amountInWords.reason}`);
    }
    if (visionData?.chequeDate?.confidence < confidenceThreshold) {
        data.reviewNotes.push(`Low confidence for Cheque Date (<90%): ${visionData.chequeDate.reason}`);
    }
    if (visionData?.amount?.confidence < confidenceThreshold) {
        data.reviewNotes.push(`Low confidence for Amount (<90%): ${visionData.amount.reason}`);
    }
    
    // NEW: Regex check for invalid characters in amount
    const rawAmountMatch = rawText.match(/RM\s*(.*)/i);
    if (rawAmountMatch && rawAmountMatch[1].match(/[^0-9.,\s]/)) {
        data.reviewNotes.push("Amount in figures contains non-standard characters.");
    }
    
    // Check for Blank Fields
    if (!data.payeeName || data.payeeName === 'N/A') data.reviewNotes.push("Payee Name is blank.");
    if (!data.payerName || data.payerName === 'N/A') data.reviewNotes.push("Payer Name is blank.");
    if (!data.chequeDate || data.chequeDate === 'N/A') data.reviewNotes.push("Date is blank.");
    if (!data.amount || data.amount === 0) data.reviewNotes.push("Amount is blank or zero.");
    
    // If any notes were added, the cheque needs review.
    if (data.reviewNotes.length > 0) {
        data.needsReview = true;
    }

    return { ...data, rawText };
};

module.exports = { processCheque };