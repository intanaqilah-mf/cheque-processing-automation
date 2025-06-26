const mongoose = require('mongoose');

const ChequeSchema = new mongoose.Schema({
    payeeName: { type: String, default: 'N/A' },
    amount: { type: Number, default: 0 },
    amountInWords: { type: String, default: 'N/A' },
    chequeDate: { type: String, default: 'N/A' },
    payerName: { type: String, default: 'N/A' },
    micr: {
        raw: { type: String, default: 'N/A' },
        chequeNo: { type: String, default: 'N/A' },
        bankCode: { type: String, default: 'N/A' },
        branchCode: { type: String, default: 'N/A' },
        payerAccountNo: { type: String, default: 'N/A' },
        tranCode: { type: String, default: 'N/A' }
    },
    bankBranchCodeCenter: { type: String, default: 'N/A' },
    rawText: { type: String, required: true },
    needsReview: { type: Boolean, default: false },
    reviewNotes: [String],
    imageUrl: { type: String, required: true },
    status: { type: String, default: 'Processed' }
}, { timestamps: true });

module.exports = mongoose.model('Cheque', ChequeSchema);