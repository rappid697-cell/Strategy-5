


        function settingsPage() {
            return {
                form: {
                    mode: 'paper',
                    paper_balance_usd: 1000,
                    private_key: '',
                    relayer: { api_key: '' },
                    chainlink: { alchemy_api_key: '' },
                    capital_extractor: { enabled: false, trigger_balance: 2000, withdraw_amount: 1000, withdraw_address: '', auto_resume_after_withdrawal: true, resume_after: 'submitted' },
                    polymarket: { series_id: '' },
                    trading: { symbol: '', risk_type: 'percent', risk_value: 10 },
                    ev: { ev_threshold: 0.04, min_prob: 0.55, min_book_liquidity_usd: 20.0 },
                    flip: { enabled: false, min_conviction: 0.80, min_minutes_left: 9.0 },
                    tp_sl: { enabled: false, take_profit_pct: 30, stop_loss_pct: 30 },
                    telegram: { enabled: false, bot_token: '' }
                },
                message: '',
                messageType: '',
                availableSeries: [],
                testBusy: false,
                testResult: '',
                testOk: false,
                tgBusy: false,
                tgResult: '',
                tgOk: false,
                tgSubs: [],
                tgSubsBusy: false,
                async init() {
                    try {
                        const [res, sRes] = await Promise.all([
                            fetch('/api/settings').then(r => r.json()),
                            fetch('/api/available-series').then(r => r.json())
                        ]);
                        this.form = res;
                        this.availableSeries = sRes;
                        if (!this.form.telegram) this.form.telegram = { enabled: false, bot_token: '' };
                        this.loadSubscribers();
                    } catch (e) {
                        console.error("Failed to load settings", e);
                    }
                },
                // Subscribers are collected automatically by the bot (anyone who
                // messages it). Just fetch the current list to display it.
                async loadSubscribers() {
                    this.tgSubsBusy = true;
                    try {
                        const res = await fetch('/api/telegram-subscribers');
                        const d = await res.json();
                        this.tgSubs = d.subscribers || [];
                    } catch (e) {
                        console.error("Failed to load subscribers", e);
                    }
                    this.tgSubsBusy = false;
                },
                async removeSubscriber(id) {
                    try {
                        await fetch('/api/telegram-unsubscribe', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: String(id) })
                        });
                        this.tgSubs = this.tgSubs.filter(s => String(s.chat_id) !== String(id));
                    } catch (e) {
                        console.error("Failed to remove subscriber", e);
                    }
                },
                async saveSettings() {
                    try {
                        const res = await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(this.form)
                        });
                        if (res.ok) {
                            this.message = "Settings Saved Successfully!";
                            this.messageType = 'success';
                            setTimeout(() => this.message = '', 3000);
                        } else {
                            throw new Error("Failed to save");
                        }
                    } catch (e) {
                        this.message = "Error Saving Settings";
                        this.messageType = 'error';
                        setTimeout(() => this.message = '', 3000);
                    }
                },
                async testCredentials() {
                    this.testBusy = true;
                    this.testResult = '';
                    try {
                        // Save first so the entered key/seed + relayer is stored and the client re-inits.
                        await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(this.form)
                        });
                        const res = await fetch('/api/test-connection', { method: 'POST' });
                        const d = await res.json();
                        if (d.ok) {
                            this.testOk = true;
                            const stName = {0:'EOA',1:'proxy',2:'safe',3:'deposit'}[d.chosen_signature_type] || d.chosen_signature_type;
                            const funded = (d.wallets || []).filter(w => w.pusd_balance > 0)
                                .map(w => '$' + Number(w.pusd_balance).toFixed(2) + ' in ' + w.address.slice(0,8) + '…');
                            this.testResult = 'Active ✓  EOA ' + d.eoa +
                                '  ·  trading wallet (' + stName + ') ' + d.funder +
                                '  ·  relayer key ' + (d.relayer_key_set ? 'set' : 'MISSING') +
                                (funded.length ? ('  ·  funds: ' + funded.join(', ')) : '  ·  no pUSD found yet — deposit on polymarket.com');
                        } else {
                            this.testOk = false;
                            this.testResult = 'Failed: ' + (d.error || 'unknown') + (d.eoa ? ('  (EOA ' + d.eoa + ')') : '');
                        }
                    } catch (e) {
                        this.testOk = false;
                        this.testResult = 'Test request failed';
                    }
                    this.testBusy = false;
                },
                async testTelegram() {
                    this.tgBusy = true;
                    this.tgResult = '';
                    try {
                        // Save first so the entered token + enabled flag are stored.
                        await fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(this.form)
                        });
                        const res = await fetch('/api/test-telegram', { method: 'POST' });
                        const d = await res.json();
                        this.tgOk = !!d.ok;
                        if (d.ok) {
                            this.tgResult = 'Sent ✓ to ' + (d.count != null ? d.count : '') + ' subscriber(s).';
                        } else {
                            this.tgResult = 'Failed: ' + (d.error || 'unknown');
                        }
                        // Refresh in case someone subscribed since the page loaded.
                        this.loadSubscribers();
                    } catch (e) {
                        this.tgOk = false;
                        this.tgResult = 'Test request failed';
                    }
                    this.tgBusy = false;
                }
            }
        }
    