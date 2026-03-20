import { Router, Request, Response } from 'express';
import multer from 'multer';
import { dynamicsService } from '../services/dynamics.service';
import fs from 'fs';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    try {
        if (!req.file) {
            res.status(400).json({ error: 'No file uploaded' });
            return;
        }

        // We accept an optional 'contactId' in the body if we want to bypass lookup, 
        // OR we can look up by phone number if provided. 
        // For testing, let's assume the user provides a phone number or we default to a test one.
        // Or better: The UI can send a "Simulated Phone Number".

        const phoneNumber = req.body.phoneNumber || '0832852913'; // Default test number

        const crmEntity = await dynamicsService.getContactByPhone(phoneNumber);

        if (!crmEntity) {
            res.status(404).json({ error: 'Contact not found for this phone number' });
            return;
        }

        await dynamicsService.uploadDocument(
            crmEntity,
            req.file.originalname,
            req.file.mimetype,
            req.file.buffer
        );

        res.json({ message: 'File uploaded and saved to Dynamics successfully', fileName: req.file.originalname });

    } catch (error: any) {
        console.error('Upload Error:', error);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

export default router;
