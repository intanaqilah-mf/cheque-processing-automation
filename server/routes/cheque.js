const express = require('express');
const router = express.Router();
const multer = require('multer');
const { processNewCheque, getReviewCheques, updateChequeData, autosaveChequeData } = require('../controllers/chequeController');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
router.put('/review/autosave/:id', autosaveChequeData);
const upload = multer({ storage: storage });
router.post('/process', upload.single('chequeImage'), processNewCheque);
router.get('/review', getReviewCheques);
router.put('/review/:id', updateChequeData);

module.exports = router;