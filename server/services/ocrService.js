const { ImageAnnotatorClient } = require('@google-cloud/vision');
const fs = require('fs');
const moment = require('moment'); 

// --- FIX #1: This function is now more robust against Gemini's output format ---
const callGeminiAPI = async (prompt, text) => {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const result = await model.generateContent(prompt + "\n" + text);
        const response = await result.response;
        const fullResponseText = response.text();

        // Use a regular expression to reliably find and extract the JSON object
        const jsonMatch = fullResponseText.match(/\{[\s\S]*\}/);

        if (jsonMatch && jsonMatch[0]) {
            return JSON.parse(jsonMatch[0]);
        } else {
            throw new Error("No valid JSON object found in Gemini response.");
        }
    } catch (error) {
        console.error('Error calling or parsing Gemini API:', error);
        return null;
    }
};

const processCheque = async (imagePath) => {
    const client = new ImageAnnotatorClient();
    const [result] = await client.textDetection(imagePath);
    const rawText = result.fullTextAnnotation?.text;

    if (!rawText) {
        throw new Error('Could not extract any text from the image.');
    }
    
    const data = {
        payeeName: 'N/A',
        amount: 0,
        amountInWords: 'N/A',
        chequeDate: 'N/A',
        payerName: 'N/A',
        micr: { raw: 'N/A', chequeNo: 'N/A', bankCode: 'N/A', branchCode: 'N/A', payerAccountNo: 'N/A', tranCode: 'N/A' },
        bankBranchCodeCenter: 'N/A',
        needsReview: false,
        reviewNotes: [],
    };
    
    // --- FIX #2: Using only one, more reliable method for Payee Name ---
    const lines = rawText.split('\n');
    const payeeLineIndex = lines.findIndex(line => line.toUpperCase().includes('PAY') || line.toUpperCase().includes('BAYAR'));
    if (payeeLineIndex !== -1 && payeeLineIndex + 1 < lines.length) {
        data.payeeName = lines[payeeLineIndex + 1].trim().replace(/\.|,/g, '');
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name using regex.");
    }
    // The redundant payeeRegex block has been removed.

    const amountBearerRegex = /(?:ATAU\s*PEMBAWA|OR\s*BEARER)\s*(?:RM)?\s*([\d,]+\.\d{2})/i;
    const amountRmRegex = /RM\s*([\d,]+\.\d{2})/i;
    let amountMatch = rawText.match(amountBearerRegex);
    if (amountMatch && amountMatch[1]) {
        data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
        amountMatch = rawText.match(amountRmRegex);
        if (amountMatch && amountMatch[1]) {
            data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
        } else {
            data.needsReview = true;
            data.reviewNotes.push("Could not parse amount in figures using regex.");
        }
    }
    
    const amountWordsRegex = /(?:RINGGIT MALAYSIA|MALAYSIA\/)\s*([A-Z\s]+?)(?:ONLY|SAHAJA)/i;
    const amountWordsMatch = rawText.match(amountWordsRegex);
    if (amountWordsMatch && amountWordsMatch[1]) {
        data.amountInWords = amountWordsMatch[1].replace(/\s+/g, ' ').trim();
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in words using regex.");
    }

    const datePattern = /(?:Tarikh|Date)\s*[:\s]*(\d{1,2})[\s\/-]?(\d{1,2})[\s\/-]?(\d{2,4})/;
    const dateMatch = rawText.match(datePattern);
    if (dateMatch) {
        let day = dateMatch[1];
        let month = dateMatch[2];
        let year = dateMatch[3];

        if (year.length === 2) {
            year = `20${year}`;
        }
        
        if (month.length === 2 && month.startsWith('8')) {
            const potentialMonth = parseInt(month.substring(1), 10);
            if (potentialMonth >= 1 && potentialMonth <= 12) {
                month = potentialMonth.toString().padStart(2, '0');
            }
        } else if (parseInt(month, 10) > 12) {
            data.needsReview = true;
            data.reviewNotes.push(`Potentially invalid month in date: ${month}.`);
        }
        
        const parsedDate = moment(`${day}-${month}-${year}`, "DD-MM-YYYY", true);
        if (parsedDate.isValid()) {
            data.chequeDate = parsedDate.format("DD-MM-YYYY");
        } else {
            data.needsReview = true;
            data.reviewNotes.push(`Could not parse or validate date: ${dateMatch[0].trim()}.`);
        }
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not find date using regex.");
    }

    const centerCodeRegex = /(\d{2}-\d{5})/;
    const centerCodeMatch = rawText.match(centerCodeRegex);
    if (centerCodeMatch) {
        data.bankBranchCodeCenter = centerCodeMatch[1];
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse bank branch code center using regex.");
    }

    const micrLineStrongRegex = /(\d+)\s*⑈\s*(\d{2})(\d{5})\s*⑆\s*(\d+)\s*⑈\s*(\d{2})/;
    const micrBlockMatch = rawText.match(micrLineStrongRegex);
    if (micrBlockMatch) {
        data.micr.raw = micrBlockMatch[0].trim();
        data.micr.chequeNo = micrBlockMatch[1];
        data.micr.bankCode = micrBlockMatch[2];
        data.micr.branchCode = micrBlockMatch[3];
        data.micr.payerAccountNo = micrBlockMatch[4];
        data.micr.tranCode = micrBlockMatch[5];
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse MICR line using regex.");
    }
    
    // Gemini Enhanced Parsing
    const geminiPrompt = `Extract key information from this cheque image OCR text. Output a single, clean JSON object without any markdown formatting or extra text.
    The JSON object must have keys like "payeeName", "amount", "amountInWords", "chequeDate", etc. If a value cannot be found, use "N/A" for strings or 0 for numbers.
    OCR Text: \`\`\`${rawText}\`\`\``;

    try {
        const geminiResponse = await callGeminiAPI(geminiPrompt, rawText);
        if (geminiResponse) {
            const geminiExtracted = geminiResponse.extractedFields || geminiResponse; // Handle both cases
            
            if (geminiExtracted.payeeName && geminiExtracted.payeeName !== 'N/A') data.payeeName = geminiExtracted.payeeName;
            if (geminiExtracted.amount && parseFloat(geminiExtracted.amount) !== 0) data.amount = parseFloat(geminiExtracted.amount);
            if (geminiExtracted.amountInWords && geminiExtracted.amountInWords !== 'N/A') data.amountInWords = geminiExtracted.amountInWords;
            if (geminiExtracted.chequeDate && moment(geminiExtracted.chequeDate, "DD-MM-YYYY", true).isValid()) data.chequeDate = geminiExtracted.chequeDate;
            if (geminiExtracted.payerName && geminiExtracted.payerName !== 'N/A') data.payerName = geminiExtracted.payerName;
            if (geminiExtracted.bankBranchCode && geminiExtracted.bankBranchCode !== 'N/A') data.bankBranchCodeCenter = geminiExtracted.bankBranchCode;

            if (geminiExtracted.micr) {
                data.micr = { ...data.micr, ...geminiExtracted.micr };
            }
        }
    } catch (geminiError) {
        console.error('Gemini API call failed during processing:', geminiError.message);
        data.needsReview = true;
        data.reviewNotes.push("Failed to get enhanced parsing from Gemini API.");
    }
    
    const requiredFields = ['payeeName', 'amount', 'amountInWords', 'chequeDate', 'payerName', 'micr.raw', 'bankBranchCodeCenter'];
    requiredFields.forEach(field => {
        const value = field.includes('.') ? data[field.split('.')[0]][field.split('.')[1]] : data[field];
        if ((typeof value === 'string' && value === 'N/A') || (typeof value === 'number' && value === 0)) {
            data.needsReview = true;
            data.reviewNotes.push(`${field} missing or invalid.`);
        }
    });
    
    data.reviewNotes = [...new Set(data.reviewNotes)];

    return { ...data, rawText };
};

module.exports = { processCheque };