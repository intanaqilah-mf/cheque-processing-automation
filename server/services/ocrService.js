const { ImageAnnotatorClient } = require('@google-cloud/vision');
const moment = require('moment');

// This function calls the Gemini API to extract data from the OCR text as a fallback.
const callGeminiAPI = async (prompt, text) => {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const result = await model.generateContent(prompt + "\n" + text);
        const response = await result.response;
        const fullResponseText = response.text();

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

// Helper function to remove known non-data text from the raw OCR output.
const cleanRawText = (text) => {
    return text
        .replace(/STAMP DUTY PAID/gi, '')
        .replace(/A\/C PAYEE ONLY/gi, '')
        .replace(/NO SIGNATURE BELOW THIS LINE/gi, '')
        .replace(/JANGAN TANDATANGAN DI BAWAH GARISAN INI/gi, '');
};


const processCheque = async (imagePath) => {
    const client = new ImageAnnotatorClient();
    const [result] = await client.textDetection(imagePath);
    let rawText = result.fullTextAnnotation?.text;

    if (!rawText) {
        throw new Error('Could not extract any text from the image.');
    }

    rawText = cleanRawText(rawText);

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

    const lines = rawText.split('\n');

    // --- Final, Highly-Targeted Payee Name Extraction ---
    let payeeName = 'N/A';
    // Find the line containing "PAY" or "BAYAR".
    const payeeLineIndex = lines.findIndex(line => line.toUpperCase().includes('PAY') || line.toUpperCase().includes('BAYAR'));

    if (payeeLineIndex !== -1) {
        let rawPayeeLine = lines[payeeLineIndex];

        // Surgically remove the "PAY/BAYAR" prefix and any non-alphabet characters next to it.
        // This isolates the name that follows.
        let cleanedPayeeLine = rawPayeeLine.replace(/^(PAY|BAYAR)[\s\/]*[^\sa-zA-Z0-9]*/i, '').trim();

        // As a final safety net, remove any "SAMPLE" text that might be overlaid.
        cleanedPayeeLine = cleanedPayeeLine.replace(/SAMPLE/gi, '').trim();
        
        // Remove any other text that may appear after the name on the same line.
        const finalPayeeMatch = cleanedPayeeLine.match(/^([a-zA-Z0-9\s,.'-]*)/);
        if (finalPayeeMatch && finalPayeeMatch[0]) {
            payeeName = finalPayeeMatch[0].trim();
        }
    }
    
    data.payeeName = payeeName;

    if (data.payeeName === 'N/A' || data.payeeName.length < 3) {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name.");
    }

    // --- Amount (Figures) Extraction ---
    const amountRegex = /RM\s*\*?([\d,]+\.\d{2})/i;
    let amountMatch = rawText.match(amountRegex);
    if (amountMatch && amountMatch[1]) {
        data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in figures.");
    }

    // --- Amount (Words) Extraction ---
    const amountWordsRegex = /(?:RINGGIT MALAYSIA|RINGGIT)\s*:?\s*([A-Z\s]+?)(?:SAHAJA|ONLY)/i;
    const amountWordsMatch = rawText.match(amountWordsRegex);
    if (amountWordsMatch && amountWordsMatch[1]) {
        data.amountInWords = amountWordsMatch[1].replace(/\s+/g, ' ').trim();
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in words.");
    }

    // --- Refined Date Extraction ---
    const spacedDatePattern = /(?:Tarikh|Date)\s*:?\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)/i;
    let dateMatch = rawText.match(spacedDatePattern);
    if (dateMatch) {
        const day = `${dateMatch[1]}${dateMatch[2]}`;
        const month = `${dateMatch[3]}${dateMatch[4]}`;
        const year = `20${dateMatch[5]}${dateMatch[6]}`;
        const parsedDate = moment(`${day}-${month}-${year}`, "DD-MM-YYYY", true);
        if (parsedDate.isValid()) {
            data.chequeDate = parsedDate.format("DD-MM-YYYY");
        } else {
            data.needsReview = true;
            data.reviewNotes.push(`Invalid spaced date detected: ${day}-${month}-${year}.`);
        }
    } else {
        const standardDatePattern = /(?:Tarikh|Date)\s*:?\s*(\d{1,2})[ \/-]?(\d{1,2})[ \/-]?(\d{2,4})/i;
        dateMatch = rawText.match(standardDatePattern);
        if (dateMatch) {
            let day = dateMatch[1].padStart(2, '0');
            let month = dateMatch[2].padStart(2, '0');
            let year = dateMatch[3];
            if (year.length === 2) year = `20${year}`;

            const parsedDate = moment(`${day}-${month}-${year}`, "DD-MM-YYYY", true);
            if (parsedDate.isValid()) {
                data.chequeDate = parsedDate.format("DD-MM-YYYY");
            } else {
                data.needsReview = true;
                data.reviewNotes.push(`Could not validate date from string: ${dateMatch[0]}.`);
            }
        } else {
            data.needsReview = true;
            data.reviewNotes.push("Could not find date.");
        }
    }


    // --- Bank/Branch Code Center Extraction ---
    const centerCodeRegex = /(\d{2}-\d{5})/;
    const centerCodeMatch = rawText.match(centerCodeRegex);
    if (centerCodeMatch) {
        data.bankBranchCodeCenter = centerCodeMatch[1];
    } else {
        data.reviewNotes.push("Could not parse bank branch code center.");
    }

    // --- Refined MICR Line Extraction ---
    const micrLineCandidate = lines.find(line => (line.match(/\d/g) || []).length > 15 && (line.includes('I') || line.includes('"') || line.includes(':')));
    if (micrLineCandidate) {
        data.micr.raw = micrLineCandidate.trim();
        const cleanedMicr = micrLineCandidate.replace(/[^\d\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const parts = cleanedMicr.split(' ').filter(p => p.length > 1);

        if (parts.length >= 4) {
             data.micr.chequeNo = parts.find(p => p.length === 6 || p.length === 7);
             const bankBranchPart = parts.find(p => p.length === 7 && p !== data.micr.chequeNo);
             if(bankBranchPart) {
                 data.micr.bankCode = bankBranchPart.substring(0, 4);
                 data.micr.branchCode = bankBranchPart.substring(4);
             }
             data.micr.payerAccountNo = parts.find(p => p.length >= 8);
             const tranCodePart = parts.filter(p => p.length === 2).pop();
             if(tranCodePart) data.micr.tranCode = tranCodePart;
        } else {
            data.needsReview = true;
            data.reviewNotes.push("Could not parse MICR line into meaningful parts.");
        }
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not find or parse MICR line.");
    }
    
    // --- Gemini Enhanced Parsing (as a fallback) ---
    const geminiPrompt = `Analyze the following OCR text from a Malaysian cheque and extract the information into a clean JSON object. Do not include any markdown or explanatory text outside the JSON.
    The JSON object must have these keys: "payeeName", "amount", "amountInWords", "chequeDate" (format DD-MM-YYYY), "payerName", "micr".
    For the "micr" key, provide a nested object with: "chequeNo", "bankCode", "branchCode", "payerAccountNo", "tranCode".
    If a value is unclear, use "N/A" for strings or 0 for numbers.
    OCR Text: \`\`\`${rawText}\`\`\``;

    try {
        const geminiResponse = await callGeminiAPI(geminiPrompt, rawText);
        if (geminiResponse) {
            if ((data.payeeName === 'N/A' || data.payeeName.length < 3) && geminiResponse.payeeName && geminiResponse.payeeName !== 'N/A') data.payeeName = geminiResponse.payeeName;
            if (data.amount === 0 && geminiResponse.amount && parseFloat(geminiResponse.amount) !== 0) data.amount = parseFloat(geminiResponse.amount);
            if (data.amountInWords === 'N/A' && geminiResponse.amountInWords && geminiResponse.amountInWords !== 'N/A') data.amountInWords = geminiResponse.amountInWords;
            if (data.chequeDate === 'N/A' && geminiResponse.chequeDate && moment(geminiResponse.chequeDate, "DD-MM-YYYY", true).isValid()) data.chequeDate = geminiResponse.chequeDate;
            
            if (geminiResponse.payerName && geminiResponse.payerName !== 'N/A') data.payerName = geminiResponse.payerName;
            
            if (data.micr.chequeNo === 'N/A' && geminiResponse.micr) {
                data.micr = { ...data.micr, ...geminiResponse.micr };
            }
        }
    } catch (geminiError) {
        console.error('Gemini API call failed during enhancement:', geminiError.message);
        data.reviewNotes.push("Failed to get enhanced parsing from Gemini API.");
    }

    // --- Final Review Check ---
    const requiredFields = ['payeeName', 'amount', 'amountInWords', 'chequeDate', 'micr.chequeNo', 'micr.tranCode'];
    requiredFields.forEach(field => {
        const value = field.includes('.') ? data[field.split('.')[0]][field.split('.')[1]] : data[field];
        if (!value || value === 'N/A' || value === 0) {
            data.needsReview = true;
            // Add review note only if it's not already there
            const note = `${field} missing or invalid.`;
            if (!data.reviewNotes.includes(note)) {
                data.reviewNotes.push(note);
            }
        }
    });

    if(data.payerName === 'N/A') {
        const note = 'payerName missing or invalid.';
        if (!data.reviewNotes.includes(note)) {
            data.needsReview = true;
            data.reviewNotes.push(note);
        }
    }
    
    data.reviewNotes = [...new Set(data.reviewNotes)];

    return { ...data, rawText };
};

module.exports = { processCheque };