// server/services/ocrService.js

const { ImageAnnotatorClient } = require('@google-cloud/vision');
const fs = require('fs');

// Helper function to find a value near a keyword anchor
const findValueNear = (text, keyword, pattern) => {
    try {
        const keywordRegex = new RegExp(`${keyword}(.+)`, 'i');
        const keywordMatch = text.match(keywordRegex);
        if (keywordMatch && keywordMatch[1]) {
            const patternMatch = keywordMatch[1].trim().match(pattern);
            if (patternMatch) {
                return patternMatch[1] || patternMatch[0];
            }
        }
    } catch (e) {
        // Ignore regex errors for this helper
    }
    return null;
};

const processCheque = async (imagePath) => {
    // 1. Initialize Google Vision Client and get raw text
    const client = new ImageAnnotatorClient();
    const [result] = await client.textDetection(imagePath);
    const rawText = result.fullTextAnnotation?.text;

    if (!rawText) {
        throw new Error('Could not extract any text from the image.');
    }
    
    // 2. Initialize the data structure based on your Mongoose model
    const data = {
        payeeName: 'N/A',
        amount: 0,
        amountInWords: 'N/A',
        chequeDate: 'N/A',
        payerName: 'N/A',
        micr: { raw: 'N/A', chequeNo: 'N/A', bankCode: 'N/A', branchCode: 'N/A', payerAccountNo: 'N/A', cdv: 'N/A', tranCode: 'N/A' },
        bankBranchCodeCenter: 'N/A',
        needsReview: false,
        reviewNotes: [],
    };

    // 3. Define more robust Regex patterns
    // This pattern looks for the spaced-out DD MM YY format inside the date box
    const dateRegex = /(?:Date|Tarikh)[\s\S]*?(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)/i;
    const amountRegex = /RM\s*([,\d]+\.\d{2})/;
    // This pattern looks for the word PAY/BAYAR and captures the rest of that specific line
    const payeeRegex = /(?:PAY|BAYAR\/)\s*([^\n]+)/i;
    // This pattern finds the amount in words, which is often uppercase
    const amountWordsRegex = /(?:RINGGIT MALAYSIA|MALAYSIA\/)\s*([A-Z\s]+?)(?:ONLY|SAHAJA)/i;
    // This pattern is more flexible for the MICR line, tolerating different symbols
    const micrRegex = /(?:\s|⑆)(\d{2})(?:\s|⑈)[\s\S]*?⑆(\d{6})⑈\s*(\d{2}-\d{5})\s*⑆(\d+)⑈\s*(\d{2})/;
    // A simplified MICR regex as a fallback
    const simpleMicrRegex = /⑆\s*(\d+)\s*⑈\s*(\d+)\s*⑆\s*(\d+)\s*⑈\s*(\d+)/;
    const centerCodeRegex = /(\d{2}-\d{5})/;

    // 4. Execute parsing for each field
    const dateMatch = rawText.match(dateRegex);
    if (dateMatch) {
        data.chequeDate = `${dateMatch[1]}${dateMatch[2]}-${dateMatch[3]}${dateMatch[4]}-20${dateMatch[5]}${dateMatch[6]}`;
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse date.");
    }
    
    const amountMatch = rawText.match(amountRegex);
    if (amountMatch && amountMatch[1]) {
        data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in figures.");
    }

    const payeeMatch = rawText.match(payeeRegex);
    if (payeeMatch && payeeMatch[1]) {
        data.payeeName = payeeMatch[1].trim().replace(/\n/g, ' '); // Clean up newlines
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name.");
    }
    
    const amountWordsMatch = rawText.match(amountWordsRegex);
    if (amountWordsMatch && amountWordsMatch[1]) {
        data.amountInWords = amountWordsMatch[1].replace(/\s+/g, ' ').trim();
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in words.");
    }

    const centerCodeMatch = rawText.match(centerCodeRegex);
    if (centerCodeMatch) {
        data.bankBranchCodeCenter = centerCodeMatch[1];
    }

    // --- MICR Parsing ---
    const micrBlockMatch = rawText.match(simpleMicrRegex);
    if (micrBlockMatch) {
        data.micr.raw = micrBlockMatch[0].trim();
        data.micr.chequeNo = micrBlockMatch[1];
        const bankAndBranch = micrBlockMatch[2];
        data.micr.bankCode = bankAndBranch.substring(0, 2);
        data.micr.branchCode = bankAndBranch.substring(2);
        data.micr.payerAccountNo = micrBlockMatch[3];
        data.micr.tranCode = micrBlockMatch[4];
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse MICR line.");
    }
    
    // Heuristic for Payer Name (often bottom-left, might need review)
    const lines = rawText.split('\n');
    const signatureLineIndex = lines.findIndex(line => line.toUpperCase().includes('SIGNATURE') || line.toUpperCase().includes('TANDATANGAN'));
    if (signatureLineIndex > 1) {
        // Assume the payer name is on the line above the signature line
        const potentialPayerLine = lines[signatureLineIndex - 2] || lines[signatureLineIndex - 1];
        // Filter out non-alphabetic characters that might be noise
        data.payerName = potentialPayerLine.replace(/[^a-zA-Z\s]/g, '').trim();
    }
     if (data.payerName === 'N/A' || data.payerName.length < 3) {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payer name.");
    }

    // 5. Return all the extracted data
    return { ...data, rawText };
};

module.exports = { processCheque };