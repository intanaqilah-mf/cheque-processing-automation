const { ImageAnnotatorClient } = require('@google-cloud/vision');
const fs = require('fs');
const moment = require('moment'); 

const callGeminiAPI = async (prompt, text) => {

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); // Ensure API_KEY is set in your .env
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const result = await model.generateContent(prompt + "\n" + text);
        const response = await result.response;
        const jsonText = response.text(); // Assuming Gemini returns a JSON string
        return JSON.parse(jsonText);
    } catch (error) {
        console.error('Error calling Gemini API:', error);
        return null; // Handle API errors
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

    // Regex-based extraction (first pass or fallback)
    const payeeRegex = /(?:PAY|BAYAR\/)\s*([^\n]+)/i;
    const payeeMatch = rawText.match(payeeRegex);
    if (payeeMatch && payeeMatch[1]) {
        data.payeeName = payeeMatch[1].trim().replace(/\n/g, ' ');
    } else {
        data.needsReview = true;
        data.reviewNotes.push("Could not parse payee name using regex.");
    }

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
        
        // Handle "no month 83 so it might be month 3"
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
    const geminiPrompt = `Extract key information from this cheque image OCR text.
    Output a JSON object with the following keys:
    - "payeeName": (String) The name of the recipient, found after "PAY" or "BAYAR".
    - "amount": (Number) The numerical amount in RM, e.g., "200.00". Prioritize amounts near "ATAU PEMBAWA" or "OR BEARER".
    - "amountInWords": (String) The amount spelled out, after "RINGGIT MALAYSIA" or "MALAYSIA".
    - "chequeDate": (String) The date in "DD-MM-YYYY" format. Correct two-digit years (e.g., "24" -> "2024"). If month is "83", interpret as "03".
    - "payerName": (String) The name of the cheque issuer, consisting of words, distinct from numbers.
    - "payerAccountNo": (String) The payer's account number (can be from MICR or other parts).
    - "bankBranchCodeCenter": (String) The bank/branch code in "XX-XXXXX" format.
    - "micr": (Object) Detailed MICR fields.
        - "raw": (String) The full MICR line.
        - "chequeNo": (String) Cheque serial number.
        - "bankCode": (String) Bank code.
        - "branchCode": (String) Branch code.
        - "payerAccountNoFromMicr": (String) Payer's account number from MICR.
        - "tranCode": (String) Transaction code.
    - "needsReview": (Boolean) True if any info is uncertain or missing.
    - "reviewNotes": (Array of Strings) Reasons for review.

    OCR Text: \`\`\`${rawText}\`\`\``;

    try {
        const geminiResponse = await callGeminiAPI(geminiPrompt, rawText);
        if (geminiResponse && geminiResponse.extractedFields) {
            const geminiExtracted = geminiResponse.extractedFields;
            
            // Apply Gemini's extracted values, prioritizing them
            if (geminiExtracted.payeeName && geminiExtracted.payeeName !== 'N/A') data.payeeName = geminiExtracted.payeeName;
            if (geminiExtracted.amount && parseFloat(geminiExtracted.amount) !== 0) data.amount = parseFloat(geminiExtracted.amount);
            if (geminiExtracted.amountInWords && geminiExtracted.amountInWords !== 'N/A') data.amountInWords = geminiExtracted.amountInWords;
            if (geminiExtracted.chequeDate && moment(geminiExtracted.chequeDate, "DD-MM-YYYY", true).isValid()) data.chequeDate = geminiExtracted.chequeDate;
            if (geminiExtracted.payerName && geminiExtracted.payerName !== 'N/A') data.payerName = geminiExtracted.payerName;
            if (geminiExtracted.bankBranchCode && geminiExtracted.bankBranchCode !== 'N/A') data.bankBranchCodeCenter = geminiExtracted.bankBranchCode;

            if (geminiExtracted.micr) {
                if (geminiExtracted.micr.raw && geminiExtracted.micr.raw !== 'N/A') data.micr.raw = geminiExtracted.micr.raw;
                if (geminiExtracted.micr.chequeNo && geminiExtracted.micr.chequeNo !== 'N/A') data.micr.chequeNo = geminiExtracted.micr.chequeNo;
                if (geminiExtracted.micr.bankCode && geminiExtracted.micr.bankCode !== 'N/A') data.micr.bankCode = geminiExtracted.micr.bankCode;
                if (geminiExtracted.micr.branchCode && geminiExtracted.micr.branchCode !== 'N/A') data.micr.branchCode = geminiExtracted.micr.branchCode;
                if (geminiExtracted.micr.payerAccountNoFromMicr && geminiExtracted.micr.payerAccountNoFromMicr !== 'N/A') data.micr.payerAccountNo = geminiExtracted.micr.payerAccountNoFromMicr;
                if (geminiExtracted.micr.tranCode && geminiExtracted.micr.tranCode !== 'N/A') data.micr.tranCode = geminiExtracted.micr.tranCode;
            }

            if (geminiResponse.needsReview === true) data.needsReview = true;
            if (Array.isArray(geminiResponse.reviewNotes) && geminiResponse.reviewNotes.length > 0) {
                data.reviewNotes = [...new Set([...data.reviewNotes, ...geminiResponse.reviewNotes])];
            }
        }
    } catch (geminiError) {
        console.error('Gemini API call failed:', geminiError.message);
        data.needsReview = true;
        data.reviewNotes.push("Failed to get enhanced parsing from Gemini API.");
    }
    
    // Final check for review flags
    const requiredFields = [
        data.payeeName, data.amount, data.amountInWords, data.chequeDate,
        data.payerName, data.micr.raw, data.bankBranchCodeCenter
    ];
    if (requiredFields.some(field => (typeof field === 'string' && field === 'N/A') || (typeof field === 'number' && field === 0))) {
        data.needsReview = true;
        if (data.payeeName === 'N/A') data.reviewNotes.push("Payee Name missing.");
        if (data.amount === 0) data.reviewNotes.push("Amount missing.");
        if (data.amountInWords === 'N/A') data.reviewNotes.push("Amount in Words missing.");
        if (data.chequeDate === 'N/A') data.reviewNotes.push("Cheque Date missing.");
        if (data.payerName === 'N/A') data.reviewNotes.push("Payer Name missing.");
        if (data.micr.raw === 'N/A') data.reviewNotes.push("MICR raw data missing.");
        if (data.bankBranchCodeCenter === 'N/A') data.reviewNotes.push("Bank Branch Code Center missing.");
    }
    data.reviewNotes = [...new Set(data.reviewNotes)]; // Ensure unique review notes

    return { ...data, rawText };
};

module.exports = { processCheque };