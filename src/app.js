const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const { Sequelize } = require('sequelize');

const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { id } = req.params;

    const contract = await Contract.findOne({
        where: { id },
        include: [
            { model: req.app.get('models').Profile, as: 'Client' },
            { model: req.app.get('models').Profile, as: 'Contractor' }
        ]
    });

    if (!contract) return res.status(404).end();
    if (contract.ClientId !== req.profile.id && contract.ContractorId !== req.profile.id) {
        return res.status(403).end();
    }

    res.json(contract);
});

app.get('/contracts', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');

    const contracts = await Contract.findAll({
        where: {
            status: { [Sequelize.Op.not]: 'terminated' },
            [Sequelize.Op.or]: [
                { ClientId: req.profile.id },
                { ContractorId: req.profile.id }
            ]
        }
    });

    res.json(contracts);
});

app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get('models');
    const { id: profileId } = req.profile;

    const jobs = await Job.findAll({
        where: {
            [Sequelize.Op.or]: [
                { paid: false },              
                { paid: { [Sequelize.Op.is]: null } }
            ]
        },
        include: [
            {
                model: Contract,
                where: {
                    status: 'in_progress',
                    [Sequelize.Op.or]: [
                        { ClientId: profileId },
                        { ContractorId: profileId }
                    ]
                }
            }
        ]
    });

    if (!jobs.length) return res.status(404).json({ message: 'No unpaid jobs found' });
    res.json(jobs);
});

app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { job_id } = req.params;

    const job = await Job.findOne({
        where: { id: job_id, paid: { [Sequelize.Op.is]: null } },
        include: { model: Contract, include: ['Client', 'Contractor'] }
    });

    if (!job) return res.status(404).end();

    const client = job.Contract.Client;
    const contractor = job.Contract.Contractor;

    if (req.profile.id !== client.id) return res.status(403).json({ error: 'Unauthorized user' }).end();
    if (client.balance < job.price) return res.status(400).json({ error: 'Insufficient balance' });

    await sequelize.transaction(async (t) => {
        client.balance -= job.price;
        contractor.balance += job.price;
        job.paid = true;
        job.paymentDate = new Date();

        await client.save({ transaction: t });
        await contractor.save({ transaction: t });
        await job.save({ transaction: t });
    });

    res.json(job);
});

app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { Profile, Job, Contract } = req.app.get('models');
    const { userId } = req.params;
    const { amount } = req.body;

    if (req.profile.type !== 'client') return res.status(403).end();

    const user = await Profile.findOne({ where: { id: userId } });
    if (!user || user.type !== 'client') return res.status(404).end();

    const unpaidJobs = await Job.findAll({
        where: { paid: { [Sequelize.Op.is]: null } },
        include: {
            model: Contract,
            where: { ClientId: userId, status: 'in_progress' }
        }
    });

    const unpaidTotal = unpaidJobs.reduce((sum, job) => sum + job.price, 0);
    const maxDeposit = unpaidTotal * 0.25;
    console.log(unpaidTotal)
    if (amount > maxDeposit) return res.status(400).json({ error: 'Deposit exceeds 25% of unpaid jobs total' });

    user.balance += amount;
    await user.save();

    res.json(user);
});

app.get('/admin/best-profession', async (req, res) => {
    const { start, end } = req.query;

    if (!start || !end) {
        return res.status(400).json({ error: 'Start and end dates are required' });
    }

    try {
        const results = await sequelize.query(
            `
            SELECT p.profession, SUM(j.price) AS total_earned
            FROM Profiles p
            INNER JOIN Contracts c ON c.ContractorId = p.id
            INNER JOIN Jobs j ON j.ContractId = c.id
            WHERE j.paid = 1
              AND j.paymentDate BETWEEN :start AND :end
            GROUP BY p.profession
            ORDER BY total_earned DESC
            LIMIT 1;
            `,
            {
                replacements: { start, end },
                type: Sequelize.QueryTypes.SELECT,
            }
        );

        if (!results.length) {
            return res.status(404).json({ message: 'No data found for the given time range' });
        }

        res.json(results[0]); 
    } catch (error) {
        console.error('Query Error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});



app.get('/admin/best-clients', async (req, res) => {
    const { start, end, limit = 2 } = req.query;

    if (!start || !end) {
        return res.status(400).json({ error: 'Start and end dates are required' });
    }

    try {
        const results = await sequelize.query(
            `
            SELECT 
                p.id AS id,
                (p.firstName || ' ' || p.lastName) AS fullName,
                SUM(j.price) AS total_paid
            FROM Profiles p
            INNER JOIN Contracts c ON c.ClientId = p.id
            INNER JOIN Jobs j ON j.ContractId = c.id
            WHERE j.paid = 1
              AND j.paymentDate BETWEEN :start AND :end
            GROUP BY p.id
            ORDER BY total_paid DESC
            LIMIT :limit;
            `,
            {
                replacements: { start, end, limit: parseInt(limit, 10) },
                type: sequelize.QueryTypes.SELECT,
            }
        );

        if (!results.length) {
            return res.status(404).json({ message: 'No data found for the given time range' });
        }

        res.json(results);
    } catch (error) {
        console.error('Query Error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

module.exports = app;
