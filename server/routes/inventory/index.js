import express from 'express';
import locationsRouter from './locations.js';
import categoriesRouter from './categories.js';
import itemsRouter from './items.js';
import entriesRouter from './entries.js';
import deadlinesFeedRouter from './deadlines-feed.js';
import barcodeRouter from './barcode.js';

const router = express.Router();
router.use('/locations', locationsRouter);
router.use('/categories', categoriesRouter);
router.use('/items', itemsRouter);
router.use('/entries', entriesRouter);
router.use('/deadlines-feed', deadlinesFeedRouter);
router.use('/barcode', barcodeRouter);

export default router;
