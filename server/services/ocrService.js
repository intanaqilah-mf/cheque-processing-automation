const { ImageAnnotatorClient } = require('@google-cloud/vision');
const moment = require('moment');

// This function calls the Gemini API to extract data from the OCR text as a fallback.
// It is designed to reliably extract the JSON object from Gemini's response.
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

    const lines = rawText.split('\n');

    // --- Payee Name Extraction (Working as per user feedback) ---
    const payeeLineIndex = lines.findIndex(line => line.toUpperCase().includes('PAY') || line.toUpperCase().includes('BAYAR'));
    if (payeeLineIndex !== -1 && payeeLineIndex + 1 < lines.length) {
        data.payeeName = lines[payeeLineIndex + 1].trim().replace(/\.|,/g, '');
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name.");
    }

    // --- Improved Amount (Figures) Extraction ---
    const amountRegex = /RM\s*\*?([\d,]+\.\d{2})/i;
    let amountMatch = rawText.match(amountRegex);
    if (amountMatch && amountMatch[1]) {
        data.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in figures.");
    }

    // --- Improved Amount (Words) Extraction ---
    const amountWordsRegex = /(?:RINGGIT MALAYSIA|RINGGIT)\s*:?\s*([A-Z\s]+?)(?:SAHAJA|ONLY)/i;
    const amountWordsMatch = rawText.match(amountWordsRegex);
    if (amountWordsMatch && amountWordsMatch[1]) {
        data.amountInWords = amountWordsMatch[1].replace(/\s+/g, ' ').trim();
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse amount in words.");
    }

    // --- Improved Date Extraction ---
    // First, try to find a date where digits are separated by spaces (e.g., 2 6 0 6 2 0 2 5)
    const spacedDatePattern = /(?:Tarikh|Date)\s*:?\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)\s*(\d)/i;
    let dateMatch = rawText.match(spacedDatePattern);
    if (dateMatch) {
        const day = `${dateMatch[1]}${dateMatch[2]}`;
        const month = `${dateMatch[3]}${dateMatch[4]}`;
        const year = `${dateMatch[5]}${dateMatch[6]}${dateMatch[7]}${dateMatch[8]}`;
        const parsedDate = moment(`${day}-${month}-${year}`, "DD-MM-YYYY", true);
        if (parsedDate.isValid()) {
            data.chequeDate = parsedDate.format("DD-MM-YYYY");
        } else {
            data.needsReview = true;
            data.reviewNotes.push(`Invalid spaced date detected: ${day}-${month}-${year}.`);
        }
    } else {
        // Fallback to a more standard date pattern
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

    // --- Bank/Branch Code Center (Working as per user feedback) ---
    const centerCodeRegex = /(\d{2}-\d{5})/;
    const centerCodeMatch = rawText.match(centerCodeRegex);
    if (centerCodeMatch) {
        data.bankBranchCodeCenter = centerCodeMatch[1];
    } else {
        data.reviewNotes.push("Could not parse bank branch code center.");
    }
    
    // --- Improved MICR Line Extraction ---
    // This regex looks for the common MICR structure, allowing for OCR errors on symbols.
    // Groups: 1:ChequeNo, 2:Bank+Branch, 3:AccountNo, 4:TranCode
    const micrRegex = /\b(\d{6,7})\b[^\w\r\n]*(\d{7})[^\w\r\n]*(\d{7,12})[^\w\r\n]*(\d{2,3})\b/;
    const micrMatch = rawText.match(micrRegex);
    if (micrMatch) {
        data.micr.raw = micrMatch[0].trim();
        data.micr.chequeNo = micrMatch[1];
        const bankBranch = micrMatch[2]; // Expects 7 digits (e.g., 4 for bank, 3 for branch)
        data.micr.bankCode = bankBranch.substring(0, 4);
        data.micr.branchCode = bankBranch.substring(4);
        data.micr.payerAccountNo = micrMatch[3];
        data.micr.tranCode = micrMatch[4];
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse MICR line.");
    }

    // --- Gemini Enhanced Parsing (as a fallback) ---
    const geminiPrompt = `Analyze the following OCR text from a Malaysian cheque and extract the information into a clean JSON object. Do not include any markdown or explanatory text outside the JSON.
    The JSON object must have these keys: "payeeName", "amount", "amountInWords", "chequeDate" (format DD-MM-YYYY), "payerName", "micr".
    For the "micr" key, provide a nested object with: "chequeNo", "bankCode", "branchCode", "payerAccountNo".
    If a value is unclear, use "N/A" for strings or 0 for numbers.
    OCR Text: \`\`\`${rawText}\`\`\``;

    try {
        const geminiResponse = await callGeminiAPI(geminiPrompt, rawText);
        if (geminiResponse) {
            // Overwrite fields only if Gemini provides a valid value and regex failed
            if (data.payeeName === 'N/A' && geminiResponse.payeeName && geminiResponse.payeeName !== 'N/A') data.payeeName = geminiResponse.payeeName;
            if (data.amount === 0 && geminiResponse.amount && parseFloat(geminiResponse.amount) !== 0) data.amount = parseFloat(geminiResponse.amount);
            if (data.amountInWords === 'N/A' && geminiResponse.amountInWords && geminiResponse.amountInWords !== 'N/A') data.amountInWords = geminiResponse.amountInWords;
            if (data.chequeDate === 'N/A' && geminiResponse.chequeDate && moment(geminiResponse.chequeDate, "DD-MM-YYYY", true).isValid()) data.chequeDate = geminiResponse.chequeDate;
            
            // Payer name is primarily handled by Gemini due to its complex positioning
            if (geminiResponse.payerName && geminiResponse.payerName !== 'N/A') data.payerName = geminiResponse.payerName;
            
            // Overwrite MICR fields if regex failed
            if (data.micr.chequeNo === 'N/A' && geminiResponse.micr) {
                data.micr = { ...data.micr, ...geminiResponse.micr };
            }
        }
    } catch (geminiError) {
        console.error('Gemini API call failed during enhancement:', geminiError.message);
        data.reviewNotes.push("Failed to get enhanced parsing from Gemini API.");
    }

    // --- Final Review Check ---
    const requiredFields = ['payeeName', 'amount', 'amountInWords', 'chequeDate', 'micr.chequeNo'];
    requiredFields.forEach(field => {
        const value = field.includes('.') ? data[field.split('.')[0]][field.split('.')[1]] : data[field];
        if (!value || value === 'N/A' || value === 0) {
            data.needsReview = true;
            data.reviewNotes.push(`${field} missing or invalid.`);
        }
    });

    // Payer Name is often subjective, so we flag for review if it's missing.
    if(data.payerName === 'N/A') {
        data.needsReview = true;
        data.reviewNotes.push('payerName missing or invalid.');
    }
    
    data.reviewNotes = [...new Set(data.reviewNotes)];

    return { ...data, rawText };
};

module.exports = { processCheque };