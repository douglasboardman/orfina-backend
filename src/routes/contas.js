const express = require('express');
const router = express.Router();
const contasController = require('../controllers/contasController');
const { protegerRota } = require('../middlewares/authMiddleware');

router.use(protegerRota);

router.get('/:id', contasController.retornarConta);
router.get('/listar', contasController.listarContas);
router.get('/listarPorTitular/:titularId', contasController.listarContasPorTitular);
router.post('/', contasController.criarConta);
router.put('/:id', contasController.editarConta);
router.delete('/:id', contasController.excluirConta);

module.exports = router;