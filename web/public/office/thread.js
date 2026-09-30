/* Kady <-> LibreOffice UNO adapter. Runs in the WASM worker, not the page. */
'use strict';
Module.zetajs.then(zeta => {
  const css = zeta.uno.com.sun.star, context = zeta.getUnoComponentContext();
  const desktop = css.frame.Desktop.create(context);
  let model, kind, exporting = false, advanced = false;
  const statusListeners = [];
  const property = (Name, Value) => new css.beans.PropertyValue({ Name, Value });
  const send = (cmd, extra = {}) => zeta.mainPort.postMessage({ cmd, ...extra });
  const execute = (command, args = {}) => css.frame.DispatchHelper.create(context).executeDispatch(
    model.getCurrentController().getFrame(), command, '', 0,
    Object.entries(args).map(([name, value]) => property(name,
      typeof value === 'number' ? new zeta.Any(name === 'FontHeight.Height' ? zeta.type.float : name.startsWith('Zoom.') ? zeta.type.short : zeta.type.long, value) : value)));
  function configure(nodepath) {
    return css.configuration.ConfigurationProvider.create(context).createInstanceWithArguments(
      'com.sun.star.configuration.ConfigurationUpdateAccess', [property('nodepath', nodepath)]);
  }
  function theme(dark) {
    try {
      const misc = configure('/org.openoffice.Office.Common/Misc');
      misc.setPropertyValue('ApplicationAppearance', new zeta.Any(zeta.type.short, dark ? 2 : 1)); misc.commitChanges();
      const colors = configure('/org.openoffice.Office.UI/ColorScheme');
      const schemes = colors.getByName('ColorSchemes');
      if (!schemes.hasByName('Kady')) schemes.insertByName('Kady', schemes.createInstance());
      colors.setPropertyValue('CurrentColorScheme', 'Kady');
      const current = schemes.getByName('Kady');
      for (const [name, value] of Object.entries({ AppBackground: dark ? 0x202020 : 0xf4f4f5, DocColor: 0xffffff, FontColor: 0x141414 })) {
        current.getByName(name).setPropertyValue('Color', new zeta.Any(zeta.type.long, value));
      }
      colors.commitChanges();
    } catch (e) { console.warn('Office appearance unavailable:', String(e)); }
  }
  function chrome() {
    const layout = model.getCurrentController().getFrame().LayoutManager;
    layout.setVisible(advanced);
    if (advanced) {
      for (const resource of ['menubar/menubar', 'toolbar/standardbar',
        kind === 'xlsx' ? 'toolbar/formatobjectbar' : kind === 'pptx' ? 'toolbar/drawingobjectbar' : 'toolbar/textobjectbar', 'statusbar/statusbar']) {
        const url = 'private:resource/' + resource;
        layout.createElement(url); layout.showElement(url);
      }
    }
  }
  function cellSelection() {
    if (kind !== 'xlsx') return;
    try {
      const selected = model.getCurrentController().getSelection();
      const range = selected.getRangeAddress();
      const cell = model.getSheets().getByIndex(range.Sheet).getCellByPosition(range.StartColumn, range.StartRow);
      let column = '', n = range.StartColumn + 1;
      while (n) { n--; column = String.fromCharCode(65 + n % 26) + column; n = Math.floor(n / 26); }
      send('selection', { cell: column + (range.StartRow + 1), formula: cell.getFormula() });
    } catch { /* Multi-range and chart selections do not expose a single cell. */ }
  }
  function watchCommands() {
    const frame = model.getCurrentController().getFrame();
    for (const command of ['Bold', 'Italic', 'Underline', 'CharFontName', 'FontHeight', 'LeftPara', 'CenterPara', 'RightPara', 'AlignLeft', 'AlignHorizontalCenter', 'AlignRight', 'JustifyPara', 'DefaultBullet', 'DefaultNumbering', 'Undo', 'Redo', 'EnterString']) {
      try {
        const url = new css.util.URL({ Complete: '.uno:' + command, Protocol: '.uno:', Path: command });
        const target = frame.queryDispatch(url, '_self', 0);
        if (!target) continue;
        const listener = zeta.unoObject([css.frame.XStatusListener], {
          statusChanged(e) {
            let value = zeta.fromAny(e.State);
            if (command === 'CharFontName') value = value?.Name || value?.FamilyName || '';
            else if (command === 'FontHeight') value = value?.Height;
            else if (command === 'Underline') value = typeof value === 'number' ? value > 0 : value?.LineStyle > 0;
            if (!['string', 'number', 'boolean'].includes(typeof value)) value = undefined;
            send('command-state', { command: '.uno:' + command, enabled: e.IsEnabled, value });
          }, disposing() {},
        });
        statusListeners.push(listener); target.addStatusListener(listener, url);
      } catch (e) { console.warn('Office command state unavailable:', command, String(e)); }
    }
  }
  zeta.mainPort.onmessage = event => {
    try {
      const message = event.data;
      if (message.cmd === 'load') {
        kind = message.filename.split('.').pop();
        theme(!!message.dark);
        model = desktop.loadComponentFromURL('file:///tmp/office/' + message.filename, '_default', 0, [
          property('MacroExecutionMode', new zeta.Any(zeta.type.short, 0)),
          property('UpdateDocMode', new zeta.Any(zeta.type.short, 0)),
          property('ReadOnly', message.readOnly),
        ]);
        if (!model) throw Error('The document could not be opened. Encrypted files are not supported.');
        model.getCurrentController().getFrame().getContainerWindow().FullScreen = true;
        model.addModifyListener(zeta.unoObject([css.util.XModifyListener], {
          modified() { if (!exporting && model.isModified()) send('modified'); }, disposing() {},
        }));
        // Route file commands through Kady, not the engine's virtual filesystem.
        // Opening a second document internally would leave the host bound to the
        // first model, so those commands are disabled in this single-file workspace.
        const saveCommands = ['.uno:Save', '.uno:SaveAll'];
        const commands = [...saveCommands, '.uno:SaveAs', '.uno:SaveACopy', '.uno:Open',
          '.uno:OpenFromCalc', '.uno:OpenFromWriter',
          '.uno:OpenRemote', '.uno:NewDoc', '.uno:AddDirect', '.uno:CloseDoc', '.uno:Quit'];
        const isFileCommand = url => commands.includes(url.Complete) || url.Complete.startsWith('private:factory/');
        let slave = null, master = null;
        const dispatch = zeta.unoObject([css.frame.XDispatch], {
          dispatch(url) {
            if (saveCommands.includes(url.Complete)) { if (!message.readOnly) send('save-request'); }
            else if (['.uno:SaveAs', '.uno:SaveACopy'].includes(url.Complete)) send('download-request');
          },
          addStatusListener(listener, url) {
            listener.statusChanged(new css.frame.FeatureStateEvent({
              FeatureURL: url, IsEnabled: saveCommands.includes(url.Complete) ? !message.readOnly : ['.uno:SaveAs', '.uno:SaveACopy'].includes(url.Complete),
              Requery: false,
            }));
          },
          removeStatusListener() {},
        });
        const interceptor = zeta.unoObject([css.frame.XDispatchProviderInterceptor, css.frame.XInterceptorInfo], {
          getInterceptedURLs() { return [...commands, 'private:factory/*']; },
          getSlaveDispatchProvider() { return slave; }, setSlaveDispatchProvider(value) { slave = value; },
          getMasterDispatchProvider() { return master; }, setMasterDispatchProvider(value) { master = value; },
          queryDispatch(url, target, flags) { return isFileCommand(url) ? dispatch : slave?.queryDispatch(url, target, flags) ?? null; },
          queryDispatches(requests) { return requests.map(r => this.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags)); },
        });
        model.getCurrentController().getFrame().registerDispatchProviderInterceptor(interceptor);
        chrome(); watchCommands();
        model.getCurrentController().addSelectionChangeListener(zeta.unoObject([css.view.XSelectionChangeListener], {
          selectionChanged() { cellSelection(); }, disposing() {},
        }));
        cellSelection(); send('opened');
      } else if (message.cmd === 'theme') { theme(!!message.dark);
      } else if (message.cmd === 'chrome' && model) { advanced = !!message.advanced; chrome();
      } else if (message.cmd === 'command' && model && /^\.uno:[A-Za-z0-9]+$/.test(message.command)) {
        execute(message.command, message.args || {}); cellSelection();
      } else if (message.cmd === 'export' && model) {
        send('export-started', { id: message.id });
        exporting = true;
        // Calc's active cell editor is separate from the document model until
        // accepted. Commit it before exporting so clicking Save cannot lose it.
        if (kind === 'xlsx') css.frame.DispatchHelper.create(context).executeDispatch(
          model.getCurrentController().getFrame(), '.uno:AcceptFormula', '', 0, [property('SynchronMode', true)]);
        const filters = { docx: 'Office Open XML Text', xlsx: 'Calc MS Excel 2007 XML', pptx: 'Impress MS PowerPoint 2007 XML' };
        model.storeToURL('file:///tmp/office/export.' + kind, [property('FilterName', filters[kind]), property('Overwrite', true)]);
        exporting = false; send('exported', { id: message.id });
      }
    } catch (error) { exporting = false; send('error', { message: 'Office could not complete this operation. ' + String(error) }); }
  };
  send('ready');
});
