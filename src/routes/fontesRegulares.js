const express = require('express');
const router = express.Router();
const fontesRegularesController = require('../controllers/fontesRegularesController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', fontesRegularesController.retornarFonteRegular);
router.get('/listar', fontesRegularesController.listarFontesRegulares);
router.get('/listarPorAgente/:agenteId', fontesRegularesController.listarFontesRegularesPorAgentePagador);
router.get('/listarPorConta/:contaId', fontesRegularesController.listarFontesRegularesPorContaDestino);
router.get('/listarPorDescritivo/:descritivoId', fontesRegularesController.listarFontesRegularesPorDescritivo);
router.post('/', fontesRegularesController.criarFonteRegular);
router.put('/:id', fontesRegularesController.editarFonteRegular);
router.delete('/:id', fontesRegularesController.excluirFonteRegular);

module.exports = router;